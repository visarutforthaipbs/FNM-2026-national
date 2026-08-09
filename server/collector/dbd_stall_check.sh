#!/bin/bash
# Restart the DBD collection if it has stopped making progress.
#
# systemd's Restart=on-failure only catches processes that exit. A crawler whose
# HTTP requests hang does not exit — every worker blocks on a socket and the
# unit stays "active" while achieving nothing. That is exactly what happened on
# 2026-08-09: 5h24m of apparent health with zero rows added.
#
# Liveness here is measured by output, not by process state: if the archive has
# not grown in STALL_MINUTES, the run is stuck regardless of what systemd says.
# Every stage is resumable, so restarting costs only the work in flight.
set -uo pipefail

STALL_MINUTES=20
MATCHES=/home/visarut298/dbd-archive/matches.jsonl
DETAIL=/home/visarut298/dbd-archive/detail
LOG=/home/visarut298/app/logs/dbd-stall.log

systemctl is-active --quiet dbd-collect.service || exit 0

now=$(date +%s)
newest=0
for target in "$MATCHES" "$DETAIL"; do
    [ -e "$target" ] || continue
    # Detail writes many small files, so take the newest mtime beneath it.
    t=$(find "$target" -newermt "-${STALL_MINUTES} minutes" -print -quit 2>/dev/null)
    [ -n "$t" ] && newest=$now
done

if [ "$newest" -eq 0 ]; then
    echo "$(date -Is) no output in ${STALL_MINUTES}m — restarting dbd-collect" >> "$LOG"
    systemctl restart dbd-collect.service
else
    echo "$(date -Is) progressing" >> "$LOG"
fi
