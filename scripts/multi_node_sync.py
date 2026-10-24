#!/usr/bin/env python3
"""
Multi-Node Sync & Dashboard
Pulls collected shareholder records from all active Tailscale cluster nodes,
deduplicates and merges them into high_risk_shareholders.jsonl,
and updates the client-side database.
"""

import os
import sys
import json
import subprocess
from pathlib import Path
from datetime import datetime

REPO_ROOT = Path(__file__).resolve().parents[1]
LOCAL_JSONL = Path("/Users/lighthouse-control/Documents/Personal-Project/DBD-collector/high_risk_shareholders.jsonl")
SYNC_SHAREHOLDERS = REPO_ROOT / "scripts" / "sync_shareholders_to_client.py"

REMOTE_NODES = [
    {"name": "lighthouse-field", "host": "lighthouse-field", "path": "~/shareholders_field.jsonl"},
    {"name": "lighthouse-core",  "host": "lighthouse-core",  "path": "~/shareholders_core.jsonl"},
]

def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)

def pull_and_merge():
    # 1. Read existing local records
    merged = {}
    if LOCAL_JSONL.exists():
        with open(LOCAL_JSONL, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    d = json.loads(line)
                    reg = d.get("registration_no")
                    if reg:
                        merged[reg] = d
                except Exception:
                    pass

    initial_count = len(merged)
    log(f"Local master records before sync: {initial_count:,}")

    # 2. Pull from remote nodes
    for node in REMOTE_NODES:
        host = node["host"]
        rpath = node["path"]
        name = node["name"]
        
        tmp_local = f"/tmp/{name}_shareholders.jsonl"
        cmd = ["scp", "-o", "ConnectTimeout=5", f"{host}:{rpath}", tmp_local]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode == 0 and os.path.exists(tmp_local):
            node_new = 0
            with open(tmp_local, "r", encoding="utf-8") as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        d = json.loads(line)
                        reg = d.get("registration_no")
                        if reg and reg not in merged:
                            merged[reg] = d
                            node_new += 1
                        elif reg and d.get("success") and not merged[reg].get("success"):
                            merged[reg] = d
                            node_new += 1
                    except Exception:
                        pass
            log(f"  Node {name}: synced +{node_new} new records")
        else:
            log(f"  Node {name}: waiting for initial output file...")

    final_count = len(merged)
    net_new = final_count - initial_count

    # 3. Write back master jsonl if new records found
    if net_new > 0:
        with open(LOCAL_JSONL, "w", encoding="utf-8") as f:
            for d in merged.values():
                f.write(json.dumps(d, ensure_ascii=False) + "\n")
        log(f"Merged master updated: +{net_new} new records (Total: {final_count:,})")
        
        # 4. Trigger client sync
        log("Updating client database...")
        subprocess.run([sys.executable, str(SYNC_SHAREHOLDERS)], cwd=str(REPO_ROOT), check=True)
        log("Client database updated successfully.")
    else:
        log(f"No new remote records to merge at this time. (Total: {final_count:,})")

def main():
    pull_and_merge()

if __name__ == "__main__":
    main()
