#!/bin/bash
# Resume DBD collection once the API answers again.
#
# On 2026-08-11 the API stopped responding to this host after ~47 hours of
# continuous crawling — read timeouts on /api/refresh even from a fresh session,
# while the site itself still answered plain requests. Most likely a WAF
# throttle on our address. Retrying into that gains nothing and risks extending
# it, so the collection is stopped and this probe waits for recovery instead.
#
# One cheap request every 30 minutes. If it succeeds twice in a row the service
# is started again; every stage is resumable, so nothing is lost by waiting.
set -uo pipefail

REPO=/home/visarut298/app/FNM
LOG=/home/visarut298/app/logs/dbd-resume.log
STATE=/home/visarut298/.dbd_probe_ok

systemctl is-active --quiet dbd-collect.service && { rm -f "$STATE"; exit 0; }

code=$("$REPO/server/sync/venv/bin/python" - <<'PY' 2>/dev/null
import requests
try:
    s = requests.Session()
    s.headers.update({"User-Agent": "Mozilla/5.0",
                      "Origin": "https://datawarehouse.dbd.go.th",
                      "Referer": "https://datawarehouse.dbd.go.th/"})
    r = s.post("https://datawarehouse.dbd.go.th/api/refresh", timeout=(10, 20))
    print(r.status_code)
except Exception:
    print("fail")
PY
)

if [ "$code" = "200" ]; then
    if [ -f "$STATE" ]; then
        echo "$(date -Is) API healthy twice ($code) — resuming collection" >> "$LOG"
        rm -f "$STATE"
        systemctl start dbd-collect.service
    else
        # Require two consecutive successes: a single lucky response during a
        # throttle would just walk us straight back into the block.
        touch "$STATE"
        echo "$(date -Is) API healthy ($code) — confirming on next probe" >> "$LOG"
    fi
else
    rm -f "$STATE"
    echo "$(date -Is) API still unavailable ($code)" >> "$LOG"
fi
