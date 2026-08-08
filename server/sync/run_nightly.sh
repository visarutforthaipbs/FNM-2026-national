#!/bin/bash
# Nightly DIW sync for Factory Near Me, running on lsev01 against the
# self-hosted Supabase. Publishes regenerated static data to GitHub, which
# triggers a Vercel rebuild.
#
# Safety: HANDOFF.md documents a run that silently halved factories.status.
# This script snapshots the operating-factory count before and after and
# REFUSES to publish if it drops more than 5%.
#
# !!! DO NOT SCHEDULE THIS YET (as of 2026-08-08) !!!
# pipeline.py clears the entire permits table (DELETE ?id=neq.0000...) and
# re-inserts only what it fetched, ignoring SYNC_TEST_MODE. A test run cut
# 814,588 permits to 100. factory_statistics has the same shape. A full
# production run would still shrink permits to ~241,588 (all the DIW endpoint
# returns). factory-sync.timer is intentionally left disabled until that is
# fixed. The 5% guard below only blocks PUBLISHING — it cannot undo a bad write.

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
git add client/public/data/markers client/public/data/province-counts.json client/public/data/dashboard_stats.json
if git diff --cached --quiet; then
  echo "no data changes to publish"
else
  git -c user.name="lsev01 sync" -c user.email="sync@lighthouse.local" \
      commit -q -m "chore: daily factory data sync $(date -u +%F)"
  if git push --quiet; then echo "published to GitHub (Vercel will rebuild)"; else echo "ERROR: git push failed"; exit 1; fi
fi
echo "=== done $(date -Is) ==="
