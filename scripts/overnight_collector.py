#!/usr/bin/env python3
"""
Overnight Master Shareholder Collector Runner
Processes the 11,356 prioritized Thai limited companies from master_shareholder_queue.csv,
periodically syncs completed records into the web application,
and handles transient network/captcha drops with automatic resumption.
"""

import os
import sys
import time
import json
import subprocess
from pathlib import Path
from datetime import datetime

COLLECTOR_DIR = Path("/Users/lighthouse-control/Documents/Personal-Project/DBD-collector")
VENV_PYTHON = COLLECTOR_DIR / ".venv" / "bin" / "python"
QUEUE_CSV = COLLECTOR_DIR / "master_shareholder_queue.csv"
OUTPUT_JSONL = COLLECTOR_DIR / "high_risk_shareholders.jsonl"
LOG_FILE = COLLECTOR_DIR / "overnight_progress.log"

REPO_ROOT = Path("/Users/lighthouse-control/Documents/factory-nearme-demo-1")
SYNC_SHAREHOLDERS = REPO_ROOT / "scripts" / "sync_shareholders_to_client.py"

def log(msg: str):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    formatted = f"[{timestamp}] {msg}"
    print(formatted, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(formatted + "\n")

def count_completed() -> int:
    if not OUTPUT_JSONL.exists():
        return 0
    successes = 0
    try:
        with open(OUTPUT_JSONL, "r", encoding="utf-8") as f:
            for line in f:
                d = json.loads(line)
                if d.get("success"):
                    successes += 1
    except Exception:
        pass
    return successes

def sync_to_client():
    log("Synchronizing newly collected shareholder records into client...")
    try:
        res = subprocess.run([sys.executable, str(SYNC_SHAREHOLDERS)], cwd=str(REPO_ROOT), capture_output=True, text=True)
        if res.returncode == 0:
            log("Client shareholder sync successful.")
        else:
            log(f"Sync warning: {res.stderr.strip()[:200]}")
    except Exception as e:
        log(f"Sync error: {e}")

def main():
    log("=================================================================")
    log("Starting Overnight Master Shareholder Collector")
    log(f"Queue: {QUEUE_CSV}")
    log(f"Output: {OUTPUT_JSONL}")
    log("=================================================================")

    consecutive_crashes = 0

    while True:
        completed_before = count_completed()
        log(f"Active completed count: {completed_before:,} companies")

        # Run collector
        cmd = [
            str(VENV_PYTHON),
            "-m", "dbd_collector",
            "shareholders",
            str(QUEUE_CSV),
            "--col", "reg",
            "-o", str(OUTPUT_JSONL),
            "--headless"
        ]

        try:
            start_t = time.time()
            proc = subprocess.Popen(cmd, cwd=str(COLLECTOR_DIR), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            
            # Stream output
            for line in proc.stdout:
                line_str = line.strip()
                if line_str and ("INFO" in line_str or "WARNING" in line_str or "ERROR" in line_str):
                    if "looking up" in line_str or "✓" in line_str or "✗" in line_str or "logged in" in line_str or "done:" in line_str:
                        log(line_str)
            
            proc.wait()
            elapsed = time.time() - start_t
            completed_after = count_completed()
            new_records = completed_after - completed_before

            log(f"Iteration completed in {elapsed:.1f}s. New records: +{new_records}. Total: {completed_after:,}")

            if new_records > 0:
                sync_to_client()
                consecutive_crashes = 0
            else:
                consecutive_crashes += 1

            if proc.returncode == 0 and new_records == 0:
                log("All eligible companies from the queue have been scraped! Complete.")
                break

            sleep_time = min(5 * consecutive_crashes + 5, 60)
            log(f"Pausing {sleep_time}s before next cycle...")
            time.sleep(sleep_time)

        except KeyboardInterrupt:
            log("Collector stopped by user.")
            break
        except Exception as e:
            consecutive_crashes += 1
            log(f"Collector encountered error: {e}. Retrying in 15s...")
            time.sleep(15)

    log("Overnight Master Shareholder Collector finished.")

if __name__ == "__main__":
    main()
