import json
import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

with open("server/sync/landsmaps_cookies.json") as f:
    cookies = json.load(f)

cookie_str = "; ".join([f"{c['name']}={c['value']}" for c in cookies])

headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Cookie": cookie_str,
    "Referer": "https://landsmaps.dol.go.th/"
}

url = "https://landsmaps.dol.go.th/Service/ProvinceService/configapi.json"
req = urllib.request.Request(url, headers=headers)
with urllib.request.urlopen(req, context=ctx) as res:
    raw = res.read().decode("utf-8")
    config = json.loads(raw)
    print("--- ALL URLS IN CONFIGAPI.JSON ---")
    for k, v in config.items():
        if isinstance(v, str) and ("http" in v or "api" in v or "service" in v):
            print(f"{k:32s} -> {v}")
