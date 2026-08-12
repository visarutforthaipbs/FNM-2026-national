import json
import time
import urllib.request
import ssl
from playwright.sync_api import sync_playwright

def main():
    print("Testing direct DOL GeoServer IP (110.164.49.68)...")
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    direct_urls = [
        "http://110.164.49.68:8081/geoserver/WMSDOL/wms?service=WMS&version=1.1.0&request=GetCapabilities",
        "http://110.164.49.68:8081/geoserver/wms?service=WMS&version=1.1.0&request=GetCapabilities",
        "http://110.164.49.68/geoserver/WMSDOL/wms?service=WMS&version=1.1.0&request=GetCapabilities"
    ]
    for url in direct_urls:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, context=ctx, timeout=5) as res:
                print(f"Direct IP Success ({url}): Status {res.status}, Length {len(res.read())}")
        except Exception as e:
            print(f"Direct IP Failed ({url}): {e}")

    print("\n--- Playwright Stealth Cookie Extraction for LandsMaps ---")
    try:
        from playwright_stealth import stealth_sync
        _has_stealth = True
    except Exception:
        _has_stealth = False

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()
        if _has_stealth:
            stealth_sync(page)

        requests_log = []

        def handle_response(response):
            url = response.url
            if any(k in url.lower() for k in ["api", "search", "parcel", "geoserver", "wms", "wfs", "land"]):
                requests_log.append({
                    "url": url,
                    "status": response.status,
                    "headers": dict(response.headers)
                })
                print(f"[{response.status}] {response.request.method} -> {url[:130]}")

        page.on("response", handle_response)

        try:
            print("Navigating to https://landsmaps.dol.go.th/...")
            page.goto("https://landsmaps.dol.go.th/", wait_until="networkidle", timeout=30000)
            time.sleep(3)

            cookies = context.cookies()
            print(f"\nExtracted {len(cookies)} cookies:")
            for c in cookies:
                print(f" - {c['name']} = {c['value'][:30]}... (domain: {c['domain']})")

            # Save cookies to landsmaps_cookies.json
            with open("server/sync/landsmaps_cookies.json", "w") as f:
                json.dump(cookies, f, indent=2)
            print("Saved cookies to server/sync/landsmaps_cookies.json")

        except Exception as e:
            print("Navigation error:", e)
        finally:
            browser.close()

if __name__ == "__main__":
    main()
