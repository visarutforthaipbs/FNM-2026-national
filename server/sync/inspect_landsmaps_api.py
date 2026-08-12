import json
import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# Load cookies saved from Playwright
with open("server/sync/landsmaps_cookies.json") as f:
    cookies = json.load(f)

cookie_str = "; ".join([f"{c['name']}={c['value']}" for c in cookies])

headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Cookie": cookie_str,
    "Referer": "https://landsmaps.dol.go.th/",
    "Accept": "application/json, text/plain, */*"
}

def fetch_json(url):
    print(f"\n--- Fetching {url} ---")
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, context=ctx, timeout=10) as res:
            data = json.loads(res.read().decode("utf-8"))
            if isinstance(data, list):
                print(f"List length: {len(data)} | First item: {data[0] if data else None}")
            elif isinstance(data, dict):
                print(f"Keys: {list(data.keys())}")
                print("Content preview:", json.dumps(data, ensure_ascii=False)[:300])
            return data
    except Exception as e:
        print("Error:", e)
        return None

# Fetch static datasets
province = fetch_json("https://landsmaps.dol.go.th/data/province.json")
amphur = fetch_json("https://landsmaps.dol.go.th/data/amphur.json")
config = fetch_json("https://landsmaps.dol.go.th/Service/ProvinceService/configapi.json")
jwt = fetch_json("https://landsmaps.dol.go.th/apiService/JWT/GetJWTAccessToken")
