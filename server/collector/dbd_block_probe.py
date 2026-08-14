#!/usr/bin/env python3
"""
Detect when DBD's WAF stops refusing token refreshes.

There is no published cool-down and no header that states one, so the only
honest answer is to test — sparsely. Each probe is itself a request against the
endpoint that is currently unhappy, so this makes exactly one attempt per
interval and lengthens the interval while it keeps failing. It never retries in
a tight loop, which is the behaviour that caused the block.

Exits 0 the moment a token is issued, printing how long it took.
"""

import sys
import time
from datetime import datetime

sys.path.insert(0, "/home/visarut298/app/FNM/server/collector")
from dbd_client import DBDClient  # noqa: E402

# One attempt per interval, growing while it keeps failing, capped at an hour.
INTERVALS = [600, 600, 900, 900, 1200, 1800, 1800, 3600]
started = time.time()

for attempt in range(1, 60):
    stamp = datetime.now().strftime("%H:%M:%S")
    try:
        DBDClient()
        mins = (time.time() - started) / 60
        print(f"{stamp} UNBLOCKED after {mins:.0f} min ({attempt} probes)", flush=True)
        sys.exit(0)
    except Exception as exc:
        short = str(exc).split(" for url")[0]
        mins = (time.time() - started) / 60
        wait = INTERVALS[min(attempt - 1, len(INTERVALS) - 1)]
        print(f"{stamp} still blocked ({short}) — {mins:.0f} min so far, "
              f"next probe in {wait // 60} min", flush=True)
        time.sleep(wait)

print("gave up probing", flush=True)
sys.exit(1)
