#!/bin/bash
# Run the DBD stages in sequence, never in parallel.
#
# DBD rate-limits per source address, and every node here shares one home
# connection, so two crawlers do not go twice as fast — they get HTTP 429 and
# the limiter backs both off. That already happened once: two resolvers at 1.0
# and 1.2 req/s pinned the rate to its 0.25 floor until one was killed. This
# script exists so the handoff between stages cannot repeat it.
set -uo pipefail

REPO=/home/visarut298/app/FNM
PY="$REPO/server/sync/venv/bin/python"
LOG=/home/visarut298/app/logs/dbd-chain.log
export DBD_ARCHIVE_ROOT=/home/visarut298/dbd-archive
export DATABASE_URL="$(grep '^DATABASE_URL=' "$REPO/server/.env" | cut -d= -f2-)"

exec >>"$LOG" 2>&1
echo "================ chain started $(date -Is) ================"

# Wait for the resolver. Match the python process specifically: matching the
# whole command line also matches this script's own shell, which is how an
# earlier kill hit a wrapper and left the real crawler running.
while pgrep -f "venv/bin/python dbd_resolve.py" >/dev/null 2>&1; do
    sleep 300
done
echo "resolver finished $(date -Is) — $(wc -l < "$DBD_ARCHIVE_ROOT/matches.jsonl") operators resolved"

cd "$REPO/server/collector" || exit 1

echo "--- loading matches into Postgres ---"
"$PY" dbd_load.py || { echo "ABORT: dbd_load.py failed"; exit 1; }

echo "--- fetching directors, shareholders, financials ---"
"$PY" dbd_detail.py
echo "=== chain done $(date -Is) (detail rc=$?) ==="
