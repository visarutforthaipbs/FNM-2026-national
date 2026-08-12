import json
import time
from playwright.sync_api import sync_playwright

def main():
    try:
        from playwright_stealth import stealth_sync
        _has_stealth = True
    except Exception:
        _has_stealth = False

    print("Launching Chromium to fetch DOL parcel coordinates (ค่าพิกัดแปลง)...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()
        if _has_stealth:
            stealth_sync(page)

        try:
            print("Navigating to https://landsmaps.dol.go.th/...")
            page.goto("https://landsmaps.dol.go.th/", wait_until="load", timeout=60000)
            time.sleep(8)

            # Test executing API fetch directly from page context for Krabi / Plai Phraya (81/04) or Roi Et (45/02)
            script = """
            async () => {
                const tokenRes = await fetch('https://landsmaps.dol.go.th/apiService/JWT/GetJWTAccessToken');
                const tokenJson = await tokenRes.json();
                const token = tokenJson.access_token;
                
                const searchRes = await fetch('https://landsmaps.dol.go.th/apiService/LandsMaps/GetParcelByParcelNo/', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json;charset=UTF-8',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({
                        pvcode: "45",
                        amcode: "02",
                        parcel_no: "48721"
                    })
                });
                
                const searchTxt = await searchRes.text();
                return { token, status: searchRes.status, searchTxt };
            }
            """
            
            result = page.evaluate(script)
            print("DOL API Parcel Response:")
            print(json.dumps(result, ensure_ascii=False, indent=2))

        except Exception as e:
            print("Execution Error:", e)
        finally:
            browser.close()

if __name__ == "__main__":
    main()
