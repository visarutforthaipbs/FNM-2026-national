import urllib.request
import urllib.parse
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://landsmaps.dol.go.th/",
    "Accept": "*/*"
}

def test_url(name, url):
    print(f"\n--- Testing {name} ---")
    print("URL:", url)
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, context=ctx, timeout=10) as res:
            status = res.status
            content_type = res.headers.get("Content-Type", "")
            body = res.read()
            print(f"Status: {status} | Type: {content_type} | Length: {len(body)} bytes")
            if "json" in content_type or body.startswith(b"{") or body.startswith(b"[") or body.startswith(b"<?xml"):
                print("Snippet:", body[:300].decode("utf-8", errors="ignore"))
    except Exception as e:
        print("Error:", e)

# 1. Test GeoServer WFS GetCapabilities
test_url("WFS Capabilities", "https://landsmaps.dol.go.th/geoserver/LANDSMAPS/wfs?service=WFS&version=1.0.0&request=GetCapabilities")

# 2. Test GeoServer WFS GetFeature on V_PARCEL47
test_url("WFS GetFeature V_PARCEL47 JSON", "https://landsmaps.dol.go.th/geoserver/LANDSMAPS/wfs?service=WFS&version=1.0.0&request=GetFeature&typeName=LANDSMAPS:V_PARCEL47&outputFormat=application/json&maxFeatures=2")

# 3. Test GeoServer WMS Tile
test_url("WMS Map Tile", "https://landsmaps.dol.go.th/geoserver/LANDSMAPS/wms?transparent=true&format=image%2Fpng&viewparams=utmmap%3A482442662&service=WMS&version=1.1.1&request=GetMap&styles=&layers=LANDSMAPS%3AV_PARCEL47&bbox=99.2395%2C7.8030%2C99.2422%2C7.8057&width=256&height=256&srs=EPSG%3A4326")

# 4. Test potential parcel search endpoints
test_url("Search Endpoint 1", "https://landsmaps.dol.go.th/api/land/search?parcel_no=5419")
test_url("Search Endpoint 2", "https://landsmaps.dol.go.th/geoserver/LANDSMAPS/wfs?service=WFS&version=1.0.0&request=GetFeature&typeName=LANDSMAPS:V_PARCEL47&outputFormat=application/json&cql_filter=PARCEL_NO=%275419%27")
