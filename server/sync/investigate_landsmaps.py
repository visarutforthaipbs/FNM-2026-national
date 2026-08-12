import time
from playwright.sync_api import sync_playwright

def main():
    try:
        from playwright_stealth import stealth_sync
        _has_stealth = True
    except Exception:
        _has_stealth = False

    print("Launching Chromium to investigate LandsMaps endpoints...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800}
        )
        page = context.new_page()

        if _has_stealth:
            stealth_sync(page)

        captured_urls = []

        def on_request(request):
            url = request.url
            if any(k in url.lower() for k in ["api", "service", "geoserver", "search", "parcel", "wms", "wfs", "query", "land", "map"]):
                captured_urls.append((request.method, url))
                print(f"[{request.method}] {url[:140]}")

        page.on("request", on_request)

        try:
            print("Navigating to https://landsmaps.dol.go.th/...")
            page.goto("https://landsmaps.dol.go.th/", wait_until="load", timeout=45000)
            time.sleep(5)

            title = page.title()
            print(f"Page Title: {title}")

            # Inspect input fields or search form elements
            search_inputs = page.query_selector_all("input, select, button")
            print(f"Found {len(search_inputs)} interactive elements.")
            for idx, inp in enumerate(search_inputs[:15]):
                tag = page.evaluate("el => el.tagName", inp)
                id_attr = inp.get_attribute("id") or ""
                placeholder = inp.get_attribute("placeholder") or ""
                val = inp.get_attribute("value") or ""
                text = inp.inner_text() or ""
                print(f" Element {idx} [{tag}]: id='{id_attr}', placeholder='{placeholder}', text='{text.strip()[:30]}'")

            # Wait for user or inspection
            print("Sleeping for 10 seconds to observe network activity...")
            time.sleep(10)

        except Exception as e:
            print("Error during navigation:", e)
        finally:
            browser.close()

if __name__ == "__main__":
    main()
