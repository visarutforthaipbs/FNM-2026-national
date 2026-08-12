import json
import time
from playwright.sync_api import sync_playwright

def main():
    try:
        from playwright_stealth import stealth_sync
        _has_stealth = True
    except Exception:
        _has_stealth = False

    print("Launching Playwright to test LandsMaps Browser Parcel Search API...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800}
        )
        page = context.new_page()
        if _has_stealth:
            stealth_sync(page)

        try:
            print("Navigating to https://landsmaps.dol.go.th/...")
            page.goto("https://landsmaps.dol.go.th/", wait_until="domcontentloaded", timeout=45000)
            time.sleep(3)

            # Test executing API fetch directly from page context
            script = """
            async () => {
                const tokenRes = await fetch('https://landsmaps.dol.go.th/apiService/JWT/GetJWTAccessToken');
                const tokenText = await tokenRes.text();
                
                const searchRes = await fetch('https://landsmaps.dol.go.th/apiService/LandsMaps/GetParcelByParcelNo/', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        pvcode: "81",
                        amcode: "01",
                        parcel_no: "5419"
                    })
                });
                
                const searchText = await searchRes.text();
                return { tokenText, searchText };
            }
            """
            
            result = page.evaluate(script)
            print("Browser Execution Result:")
            print(json.dumps(result, ensure_ascii=False, indent=2))

        except Exception as e:
            print("Execution Error:", e)
        finally:
            browser.close()

if __name__ == "__main__":
    main()
