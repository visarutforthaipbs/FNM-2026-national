import json
import urllib.request
import ssl
import os

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# Load cookies if available
cookie_str = ""
if os.path.exists("server/sync/landsmaps_cookies.json"):
    with open("server/sync/landsmaps_cookies.json") as f:
        cookies = json.load(f)
        cookie_str = "; ".join([f"{c['name']}={c['value']}" for c in cookies])

headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Cookie": cookie_str,
    "Referer": "https://landsmaps.dol.go.th/"
}

def download(url, save_path):
    print(f"Downloading {url} -> {save_path}...")
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, context=ctx) as res:
        data = json.loads(res.read().decode("utf-8"))
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        with open(save_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"Saved {save_path} ({len(json.dumps(data))} bytes)")

if __name__ == "__main__":
    download("https://landsmaps.dol.go.th/data/province.json", "server/data/dol_province.json")
    download("https://landsmaps.dol.go.th/data/amphur.json", "server/data/dol_amphur.json")
