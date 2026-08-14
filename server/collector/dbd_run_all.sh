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

echo "--- stage 0: refresh the operator list from the factory registry ---"
# operators.tsv is derived, not source. Without this step every run re-resolves
# a frozen list and never sees a newly registered operator — which is why this
# could not sensibly go on a timer before.
#
# Written to a temp file and size-checked before replacing the live one. A
# failed or truncated query must not be allowed to blank the list: the same
# mistake against `permits` cleared 814,588 rows on 2026-08-08 (HANDOFF.md §2),
# and a zero-line operators.tsv would silently turn the next run into a no-op.
MIN_OPERATORS=${DBD_MIN_OPERATORS:-40000}
psql "$DATABASE_URL" -At -c "
  select concat_ws(E'\t', b.legal_name, min(f.province), count(*))
    from factories f join businesses b on b.id = f.business_id
   where f.status = 'ดำเนินการ'
   group by b.legal_name
   order by count(*) desc, b.legal_name;" > operators.tsv.new

new_count=$(wc -l < operators.tsv.new)
if [ "$new_count" -lt "$MIN_OPERATORS" ]; then
    echo "REFUSING to replace operators.tsv: query returned $new_count rows, expected >= $MIN_OPERATORS."
    echo "Keeping the existing list ($(wc -l < operators.tsv 2>/dev/null || echo 0) rows) and continuing."
    rm -f operators.tsv.new
else
    mv operators.tsv.new operators.tsv
    echo "operators.tsv refreshed: $new_count operators"
fi

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
