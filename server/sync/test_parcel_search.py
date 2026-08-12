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
    "Referer": "https://landsmaps.dol.go.th/",
    "Content-Type": "application/json;charset=UTF-8",
    "Accept": "application/json, text/plain, */*"
}

# Get JWT token
token_req = urllib.request.Request("https://landsmaps.dol.go.th/apiService/JWT/GetJWTAccessToken", headers=headers)
with urllib.request.urlopen(token_req, context=ctx) as res:
    token_data = json.loads(res.read().decode("utf-8"))
    access_token = token_data.get("access_token")
    print("JWT Token:", access_token[:40] if access_token else "NONE")

if access_token:
    headers["Authorization"] = f"Bearer {access_token}"

# Test calling GetParcelByParcelNo
# Payload params: pvcode, amcode, parcel_no
# Let's test Krabi (81), amphoe (01), parcel_no (5419)
url = "https://landsmaps.dol.go.th/apiService/LandsMaps/GetParcelByParcelNo/"

payloads = [
    {"pvcode": "81", "amcode": "01", "parcel_no": "5419"},
    {"pvcode": "10", "amcode": "01", "parcel_no": "100"},
    {"pvcode": "10", "amcode": "01", "land_no": "130"}
]

for p in payloads:
    print(f"\n--- Testing POST {url} with {p} ---")
    try:
        body_bytes = json.dumps(p).encode("utf-8")
        req = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")
        with urllib.request.urlopen(req, context=ctx, timeout=10) as res:
            data = json.loads(res.read().decode("utf-8"))
            print("Status:", res.status)
            print("Response:", json.dumps(data, ensure_ascii=False))
    except Exception as e:
        print("Error:", e)
