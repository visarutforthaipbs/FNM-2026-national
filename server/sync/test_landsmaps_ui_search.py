import json
import time
from playwright.sync_api import sync_playwright

def main():
    try:
        from playwright_stealth import stealth_sync
        _has_stealth = True
    except Exception:
        _has_stealth = False

    print("Launching Chromium to test UI Parcel Search on LandsMaps...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1400, "height": 900}
        )
        page = context.new_page()
        if _has_stealth:
            stealth_sync(page)

        captured_parcel_data = []

        def on_response(response):
            url = response.url
            if "apiService/LandsMaps" in url or "GetParcel" in url:
                try:
                    text = response.text()
                    print(f"\n[DOL API RESPONSE CAPTURED] {response.status} -> {url}")
                    print(text[:600])
                    if response.status == 200:
                        captured_parcel_data.append(json.loads(text))
                except Exception as e:
                    pass

        page.on("response", on_response)

        try:
            page.goto("https://landsmaps.dol.go.th/", wait_until="load", timeout=60000)
            print("Page loaded. Waiting 10 seconds for initial overlays...")
            time.sleep(10)

            # Close any popups if present
            close_btn = page.query_selector("button.btn-close, .swal2-confirm, .close")
            if close_btn:
                try:
                    close_btn.click()
                    time.sleep(2)
                except Exception:
                    pass

            print("Attempting to locate search panel inputs...")
            # Inspect selects for province
            selects = page.query_selector_all("select")
            print(f"Found {len(selects)} select elements.")
            
            inputs = page.query_selector_all("input")
            print(f"Found {len(inputs)} input elements.")

            # Keep open for 15 seconds to observe
            time.sleep(15)

        except Exception as e:
            print("Automation Error:", e)
        finally:
            browser.close()

if __name__ == "__main__":
    main()
