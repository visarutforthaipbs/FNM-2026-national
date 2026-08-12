import json
import os

src = "server/data/landsmaps_resolved.json"
dest = "client/public/data/landsmaps_resolved.json"

if os.path.exists(src):
    with open(src, "r", encoding="utf-8") as f:
        data = json.load(f)

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"Synced {len(data)} resolved title deeds to {dest}")
else:
    print(f"Source file {src} not found.")
