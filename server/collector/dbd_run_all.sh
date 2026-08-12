#!/bin/bash
# Run every DBD stage to completion, in sequence, restartably.
set -euo pipefail
umask 077

REPO=${DBD_REPO_ROOT:-/home/visarut298/app/FNM}
PY=${DBD_PYTHON:-$REPO/server/sync/venv/bin/python}
export DBD_ARCHIVE_ROOT=${DBD_ARCHIVE_ROOT:-/home/visarut298/dbd-archive}

if [ -z "${DATABASE_URL:-}" ]; then
    DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' "$REPO/server/.env" | head -n 1)
    export DATABASE_URL
fi
cd "$REPO/server/collector"

echo "================ dbd_run_all $(date -Is) ================"

while pgrep -f "venv/bin/python dbd_resolve.py" >/dev/null 2>&1; do
    echo "$(date -Is) waiting for an existing resolver to finish"
    sleep 300
done

echo "--- stage 1: resolve operator names to juristic ids ---"
"$PY" dbd_resolve.py --input operators.tsv --rate 1.2 --workers 3

echo "--- stage 2: load canonical matches into Postgres ---"
"$PY" dbd_load.py

echo "--- stage 3: fill missing profile, committee and partner endpoints ---"
"$PY" dbd_detail.py --rate 1.2

echo "--- stage 4: reload evidence after detail collection ---"
"$PY" dbd_load.py

echo "--- canonical resolution report ---"
"$PY" dbd_resolve.py --report
echo "--- strict database/archive audit ---"
"$PY" dbd_audit.py --strict
echo "=== dbd_run_all finished $(date -Is) ==="
