import json
import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# 1. Load cookies
with open("server/sync/landsmaps_cookies.json") as f:
    cookies = json.load(f)

cookie_str = "; ".join([f"{c['name']}={c['value']}" for c in cookies])

headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Cookie": cookie_str,
    "Referer": "https://landsmaps.dol.go.th/",
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*"
}

# 2. Get JWT Token
token_req = urllib.request.Request("https://landsmaps.dol.go.th/apiService/JWT/GetJWTAccessToken", headers=headers)
with urllib.request.urlopen(token_req, context=ctx) as res:
    token_resp = json.loads(res.read().decode("utf-8"))
    access_token = token_resp.get("access_token")
    print("JWT Access Token received:", access_token[:40] if access_token else "NONE")

if access_token:
    headers["Authorization"] = f"Bearer {access_token}"

# Test payloads for getservicesearch
# pvcode 10 = Bangkok, pvcode 81 = Krabi, etc.
payloads = [
    # Search by parcel no (โฉนด) 5419 in Bangkok (10) / Krabi (81)
    {"pvcode": "10", "amcode": "01", "parcel_no": "5419"},
    {"pvcode": "81", "amcode": "01", "parcel_no": "5419"},
    {"pvcode": "10", "amcode": "01", "land_no": "130"},
    {"parcel_no": "5419"}
]

endpoints = [
    "https://landsmaps.dol.go.th/apiService/LandsMaps/getservicesearch",
    "https://landsmaps.dol.go.th/apiService/LandsMaps/GetParcelByLandNo"
]

for ep in endpoints:
    print(f"\n--- Testing Endpoint: {ep} ---")
    for p in payloads:
        try:
            body_bytes = json.dumps(p).encode("utf-8")
            req = urllib.request.Request(ep, data=body_bytes, headers=headers, method="POST")
            with urllib.request.urlopen(req, context=ctx, timeout=10) as res:
                resp_json = json.loads(res.read().decode("utf-8"))
                print(f"Payload: {p} -> Response Status: {res.status}")
                print("Response:", json.dumps(resp_json, ensure_ascii=False)[:350])
        except Exception as e:
            print(f"Payload {p} Error:", e)
