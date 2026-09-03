#!/usr/bin/env python3
"""
Sync DBD business objectives and TSIC codes from dbd_index.db into client/public/data/dbd/*.json
"""

import os
import json
import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DBD_INDEX_DB = Path("/Users/lighthouse-control/Documents/Personal-Project/DBD-collector/dbd_index.db")
DBD_DIR = REPO_ROOT / "client" / "public" / "data" / "dbd"

def main():
    if not DBD_INDEX_DB.exists():
        print(f"Error: {DBD_INDEX_DB} does not exist.")
        return 1

    conn = sqlite3.connect(DBD_INDEX_DB)
    cur = conn.cursor()

    print("Reading juristic IDs from client/public/data/dbd/*.json...")
    all_jps = set()
    for f in os.listdir(DBD_DIR):
        if f.endswith(".json") and not f.endswith(".detail.json") and not f.startswith("shareholders"):
            path = DBD_DIR / f
            with open(path, "r", encoding="utf-8") as fh:
                try:
                    data = json.load(fh)
                    for fac_id, prof in data.items():
                        j = prof.get("j")
                        if j:
                            all_jps.add(j)
                except Exception:
                    pass

    print(f"Total unique DBD juristic IDs in client: {len(all_jps):,}")

    juristic_map = {}
    jp_list = list(all_jps)
    for i in range(0, len(jp_list), 900):
        batch = jp_list[i:i+900]
        q = ",".join(["?"] * len(batch))
        cur.execute(f"SELECT juristic_id, objective_code, objective FROM companies WHERE juristic_id IN ({q})", batch)
        for j_id, obj_code, obj_text in cur.fetchall():
            clean_code = (obj_code or "").strip()
            clean_text = (obj_text or "").strip()
            clean_text = clean_text.lstrip("1234567890. ()-")
            if clean_code or clean_text:
                juristic_map[j_id] = (clean_code, clean_text)

    print(f"Found {len(juristic_map):,} matching objectives in dbd_index.db")

    updated_files = 0
    updated_profs = 0
    for f in os.listdir(DBD_DIR):
        if f.endswith(".json") and not f.endswith(".detail.json") and not f.startswith("shareholders"):
            path = DBD_DIR / f
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            
            modified = False
            for fac_id, prof in data.items():
                j = prof.get("j")
                if j and j in juristic_map:
                    obj_code, obj_text = juristic_map[j]
                    if obj_text and prof.get("obj") != obj_text:
                        prof["obj"] = obj_text
                        modified = True
                    if obj_code and prof.get("tsic") != obj_code:
                        prof["tsic"] = obj_code
                        modified = True
                    if modified:
                        updated_profs += 1
            
            if modified:
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))
                updated_files += 1

    for f in os.listdir(DBD_DIR):
        if f.endswith(".detail.json"):
            path = DBD_DIR / f
            summary_f = f.replace(".detail.json", ".json")
            summary_path = DBD_DIR / summary_f
            if not summary_path.exists():
                continue
            with open(summary_path, "r", encoding="utf-8") as fh:
                summary_data = json.load(fh)
            
            with open(path, "r", encoding="utf-8") as fh:
                detail_data = json.load(fh)
            
            modified = False
            for fac_id, det in detail_data.items():
                prof = summary_data.get(fac_id)
                if prof and (prof.get("obj") or prof.get("tsic")):
                    if prof.get("obj"):
                        det["obj"] = prof["obj"]
                        modified = True
                    if prof.get("tsic"):
                        det["tsic"] = prof["tsic"]
                        modified = True

            if modified:
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(detail_data, fh, ensure_ascii=False, separators=(',', ':'))

    print(f"Successfully updated {updated_profs:,} profiles across {updated_files} province files.")
    return 0

if __name__ == "__main__":
    exit(main())
