#!/bin/bash
# Append-only mirror of the rebuildable DBD archive to the private NAS.
set -euo pipefail

ARCHIVE="${DBD_ARCHIVE_ROOT:-/home/visarut298/dbd-archive}"
REMOTE="${DBD_NAS_ROOT:-backups/dbd-archive}"

if [ ! -d "$ARCHIVE" ] || [ "$ARCHIVE" = "/" ]; then
    echo "refusing unsafe or missing DBD archive root: $ARCHIVE" >&2
    exit 2
fi

local_list=$(mktemp)
remote_list=$(mktemp)
missing_list=$(mktemp)
trap 'rm -f "$local_list" "$remote_list" "$missing_list"' EXIT

cd "$ARCHIVE"
find . -type f ! -name '*.jsonl' -print | sed 's|^./||' | LC_ALL=C sort > "$local_list"
ssh -o BatchMode=yes nas "mkdir -p ~/$REMOTE; find ~/$REMOTE -type f ! -name '*.jsonl' -print 2>/dev/null | sed 's|^.*/$REMOTE/||'" \
    | LC_ALL=C sort > "$remote_list"
comm -23 "$local_list" "$remote_list" > "$missing_list"

missing=$(wc -l < "$missing_list" | tr -d ' ')
if [ "$missing" -gt 0 ]; then
    # Most responses are already gzip-compressed. A plain tar stream avoids one
    # SSH round trip per file and never deletes anything already on the NAS.
    tar -cf - -T "$missing_list" \
        | ssh -o BatchMode=yes nas "tar -xf - -C ~/$REMOTE"
fi

# Journals are append-only but mutable, so refresh them on every mirror.
while IFS= read -r journal; do
    [ -n "$journal" ] || continue
    relative=${journal#./}
    parent=$(dirname "$relative")
    ssh -n -o BatchMode=yes nas "mkdir -p ~/$REMOTE/$parent" </dev/null
    scp -O -q -o BatchMode=yes "$ARCHIVE/$relative" "nas:~/$REMOTE/$relative" </dev/null
done < <(find . -type f -name '*.jsonl' -print)

echo "DBD NAS mirror complete: $missing immutable file(s) added; journals refreshed"
