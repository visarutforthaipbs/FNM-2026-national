import json
import time
from playwright.sync_api import sync_playwright

def main():
    try:
        from playwright_stealth import stealth_sync
        _has_stealth = True
    except Exception:
        _has_stealth = False

    print("Launching Chromium to test DOM interaction on LandsMaps...")
    with sync_playwright() as p:
        # Launch visible browser so Incapsula JS executes
        browser = p.chromium.launch(headless=False, args=["--no-sandbox", "--disable-setuid-sandbox"])
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800}
        )
        page = context.new_page()
        if _has_stealth:
            stealth_sync(page)

        responses = []

        def on_response(response):
            url = response.url
            if any(k in url.lower() for k in ["api", "parcel", "search", "getparcel"]):
                try:
                    text = response.text()
                    responses.append({"url": url, "status": response.status, "text": text[:500]})
                    print(f"\n[RESPONSE CAPTURED] {response.status} -> {url}")
                    print("Body preview:", text[:300])
                except Exception as e:
                    print(f"Error reading response for {url}:", e)

        page.on("response", on_response)

        try:
            print("Navigating to https://landsmaps.dol.go.th/...")
            page.goto("https://landsmaps.dol.go.th/", wait_until="load", timeout=60000)

            # Wait 8 seconds for Incapsula challenge & DOM load
            print("Waiting for page DOM initialization...")
            time.sleep(8)

            print("Current page title:", page.title())

            # Look for search button or inputs
            inputs = page.query_selector_all("input")
            print(f"Found {len(inputs)} input fields.")
            for i, inp in enumerate(inputs):
                id_val = inp.get_attribute("id") or ""
                placeholder = inp.get_attribute("placeholder") or ""
                print(f"Input {i}: id='{id_val}', placeholder='{placeholder}'")

            # Try closing modal if any popup appears
            close_btns = page.query_selector_all(".close, .btn-close, button:has-text('ปิด')")
            for btn in close_btns:
                try:
                    btn.click()
                    time.sleep(1)
                except Exception:
                    pass

        except Exception as e:
            print("Error in Playwright automation:", e)
        finally:
            browser.close()

if __name__ == "__main__":
    main()
