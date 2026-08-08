#!/bin/bash
# Collect a raw DIW snapshot, then mirror the archive to the NAS.
#
# Runs independently of the sync pipeline: it never touches the application
# database, so a bad night here cannot affect the live site. Collection is the
# point of failure we most want isolated, because the archive is what makes
# every other mistake recoverable.
#
# The NAS copy is the one that matters. lsev01 is a laptop on home power, and
# an archive that exists only there is a single disk away from being worthless.
set -uo pipefail

REPO=/home/visarut298/app/FNM
ARCHIVE="${DIW_ARCHIVE_ROOT:-/home/visarut298/diw-archive}"
LOGDIR=/home/visarut298/app/logs
PY="$REPO/server/sync/venv/bin/python"
# (destination handled inside mirror_to_nas)

mkdir -p "$LOGDIR"
exec >>"$LOGDIR/collector-$(date +%F).log" 2>&1

echo "================ collect $(date -Is) ================"

cd "$REPO/server/collector" || exit 1
DIW_ARCHIVE_ROOT="$ARCHIVE" "$PY" collect.py
collect_rc=$?
echo "collect.py exit: $collect_rc"

# Mirror even on partial failure — whatever was collected is still worth
# offsiting, and the manifest records which endpoints failed.
#
# scp -O rather than rsync: the Synology refuses to run rsync over ssh unless the
# rsync service is enabled in DSM ("Permission denied, please try again", which
# looks like an auth failure but is rsync's own wrapper talking). scp needs no
# DSM setting. It suits this archive anyway — blobs are content-addressed and
# immutable, so "already there" means "identical" and copying only the missing
# ones is exactly right. Nothing is ever deleted remotely.
#
# -O forces the legacy SCP protocol: this DSM exposes no SFTP subsystem, and
# OpenSSH 9+ defaults scp to SFTP, which fails with a bare "Connection closed".
mirror_to_nas() {
    local remote="backups/diw-archive"
    ssh -o BatchMode=yes nas "mkdir -p ~/$remote/blobs" || return 1

    local present
    present=$(ssh -o BatchMode=yes nas "find ~/$remote/blobs -name '*.csv.gz' 2>/dev/null | sed 's|.*/||'") || return 1

    # Work out what is missing first, then transfer. Doing the ssh calls inside
    # a `while read` loop silently truncated this to a single file: ssh inherits
    # the loop's stdin and swallows the remaining find output. Every command in
    # the transfer loop below is therefore given stdin from /dev/null.
    local missing=() base sub subdirs=()
    while IFS= read -r blob; do
        [ -n "$blob" ] || continue
        base=$(basename "$blob")
        if printf '%s\n' "$present" | grep -qxF "$base"; then
            continue
        fi
        missing+=("$blob")
        subdirs+=("$(basename "$(dirname "$blob")")")
    done < <(find "$ARCHIVE/blobs" -name '*.csv.gz' 2>/dev/null)

    local total skipped
    total=$(find "$ARCHIVE/blobs" -name '*.csv.gz' 2>/dev/null | wc -l)
    skipped=$((total - ${#missing[@]}))

    if [ ${#missing[@]} -gt 0 ]; then
        # One round trip for all the directories rather than one per blob.
        local mk
        mk=$(printf "~/$remote/blobs/%s " $(printf '%s\n' "${subdirs[@]}" | sort -u))
        ssh -n -o BatchMode=yes nas "mkdir -p $mk" </dev/null || return 1
        for blob in "${missing[@]}"; do
            sub=$(basename "$(dirname "$blob")")
            scp -O -q -o BatchMode=yes "$blob" "nas:~/$remote/blobs/$sub/" </dev/null || return 1
        done
    fi
    local copied=${#missing[@]}

    # The manifest is append-only and small, so it is always replaced wholesale.
    scp -O -q -o BatchMode=yes "$ARCHIVE/manifest.jsonl" "nas:~/$remote/" || return 1
    echo "NAS mirror: $copied new blob(s) copied, $skipped already present"
}

if mirror_to_nas; then
    echo "archive mirrored to NAS"
else
    echo "WARNING: NAS mirror failed — archive exists only on lsev01 until this is fixed"
fi

echo "archive size: $(du -sh "$ARCHIVE" 2>/dev/null | cut -f1)"
echo "=== done $(date -Is) (collect_rc=$collect_rc) ==="
exit $collect_rc
