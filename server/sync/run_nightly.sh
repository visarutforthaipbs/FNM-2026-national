#!/bin/bash
# Nightly DIW sync for Factory Near Me, running on lsev01 against the
# self-hosted Supabase. Pushes regenerated static data to GitHub.
#
# It does NOT reach the public site. Vercel is not connected to the repository —
# a deploy is triggered by hand (`vercel --prod` from client/, or the Vercel
# dashboard), deliberately, so a human gates what reaches production. Until
# someone does that, this script's output is committed and waiting, not live.
#
# Safety: HANDOFF.md documents a run that silently halved factories.status.
# This script snapshots the operating-factory count before and after and
# REFUSES to publish if it drops more than 5%.
#
# The pipeline's delete-then-insert steps (permits, factory_statistics) are
# guarded as of 2026-08-08: they no-op in test mode, and permits refuses to
# clear on an implausibly small fetch. The 5% guard below is a second layer —
# note it only blocks PUBLISHING bad exports, it cannot undo a bad DB write.

set -uo pipefail

REPO=/home/visarut298/app/FNM
LOGDIR=/home/visarut298/app/logs
mkdir -p "$LOGDIR"
exec >>"$LOGDIR/sync-$(date +%F).log" 2>&1

echo "================ run $(date -Is) ================"

count_operating() {
  docker exec supabase-db psql -U postgres -d postgres -tAc \
    "select count(*) from factories where status='ดำเนินการ'" 2>/dev/null | tr -d '[:space:]'
}

before=$(count_operating)
echo "operating factories BEFORE: ${before:-unknown}"
if ! [[ "$before" =~ ^[0-9]+$ ]]; then
  echo "ABORT: could not read baseline count (is the database up?)"
  exit 1
fi

cd "$REPO" || exit 1
# --autostash keeps any local working-tree edits (e.g. the HOST fix) intact
git pull --rebase --autostash --quiet || echo "WARN: git pull failed, continuing with current tree"

cd "$REPO/server/sync" || exit 1
./venv/bin/python pipeline.py        || { echo "ABORT: pipeline.py failed"; exit 1; }
./venv/bin/python export_markers.py  || { echo "ABORT: export_markers.py failed"; exit 1; }
./venv/bin/python export_dashboard.py|| { echo "ABORT: export_dashboard.py failed"; exit 1; }
# Zoning is a function of position, so a moved pin invalidates it — a factory
# left showing the zone of where it used to be is worse than showing none.
#
# This reads the polygons from dpt.plan_polygon (PostGIS) and does the
# point-in-polygon as an indexed spatial join, so it no longer needs the 398 MB
# dpt_geodatabase.db on this host. The polygons themselves are NOT refreshed
# here: town plans change on a scale of years, and re-fetching 71 province
# outlines from DPT every night would be rude and pointless. Reload them by
# hand when DPT publishes, with server/sync/load_dpt_polygons.py.
./venv/bin/python export_zoning.py   || { echo "WARN: export_zoning.py failed (zoning may be stale)"; }
# Refreshes the /admin พิกัดผิดจังหวัด queue, which reads this file from disk on
# this host per request. Without it the queue serves a stale report forever.
./venv/bin/python audit_province_mismatch.py || { echo "WARN: audit_province_mismatch.py failed"; }

after=$(count_operating)
echo "operating factories AFTER: ${after:-unknown}"
if ! [[ "$after" =~ ^[0-9]+$ ]]; then
  echo "ABORT: could not read post-sync count; not publishing"
  exit 1
fi

floor=$(( before * 95 / 100 ))
if [ "$after" -lt "$floor" ]; then
  echo "ABORT: operating count fell $before -> $after (below 95% floor of $floor)."
  echo "Data files NOT published. Investigate before re-running."
  exit 1
fi

cd "$REPO" || exit 1
# An explicit whitelist, not `git add -A`: this runs unattended on a checkout
# that carries local edits, and a blanket add would commit them. Anything a new
# export writes has to be listed here or it is generated nightly and never
# published — dpt_province_plans.json was exactly that for one commit.
git add client/public/data/markers client/public/data/province-counts.json \
        client/public/data/dashboard_stats.json client/public/data/zoning \
        client/public/data/zoning_summary.json client/public/data/dpt_province_plans.json \
        server/data/province_mismatch_report.json
if git diff --cached --quiet; then
  echo "no data changes to publish"
else
  git -c user.name="lsev01 sync" -c user.email="sync@lighthouse.local" \
      commit -q -m "chore: daily factory data sync $(date -u +%F)"
  if git push --quiet; then echo "pushed to GitHub — NOT yet live; trigger a Vercel deploy to publish"; else echo "ERROR: git push failed"; exit 1; fi
fi
echo "=== done $(date -Is) ==="
