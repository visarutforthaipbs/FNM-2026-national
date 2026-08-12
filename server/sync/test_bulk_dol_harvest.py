import json
import time
import asyncio
from pathlib import Path
from playwright.sync_api import sync_playwright

def main():
    json_path = Path("server/data/landsmaps_resolved.json")
    if not json_path.exists():
        print("Error: landsmaps_resolved.json not found.")
        return

    with open(json_path, "r", encoding="utf-8") as f:
        records = json.load(f)

    print(f"Loaded {len(records):,} title deed records.")
    sample = [r for r in records if r.get("pvcode") and r.get("amcode") and r.get("deed_no")][:15]
    print(f"Testing bulk coordinate harvesting for {len(sample)} sample parcels...")

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

        try:
            print("Navigating to https://landsmaps.dol.go.th/...")
            page.goto("https://landsmaps.dol.go.th/", wait_until="load", timeout=60000)
            time.sleep(6)

            script = """
            async (items) => {
                const tokenRes = await fetch('https://landsmaps.dol.go.th/apiService/JWT/GetJWTAccessToken');
                const tokenJson = await tokenRes.json();
                const token = tokenJson.access_token;

                const results = [];
                for (const item of items) {
                    try {
                        const res = await fetch('https://landsmaps.dol.go.th/apiService/LandsMaps/GetParcelByParcelNo/', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json;charset=UTF-8',
                                'Authorization': 'Bearer ' + token
                            },
                            body: JSON.stringify({
                                pvcode: String(item.pvcode),
                                amcode: String(item.amcode),
                                parcel_no: String(item.deed_no)
                            })
                        });
                        const data = await res.json();
                        results.append ? results.append(data) : results.push({ id: item.id, data });
                    } catch (err) {
                        results.push({ id: item.id, error: String(err) });
                    }
                }
                return results;
            }
            """

            start_t = time.time()
            output = page.evaluate(script, sample)
            elapsed = time.time() - start_t

            print(f"\nBulk Harvest Completed in {elapsed:.2f} seconds.")
            print(f"Returned {len(output)} responses:")
            for idx, res in enumerate(output):
                print(f"[{idx+1}] ID: {res.get('id')} | Data keys: {list(res.get('data', {}).keys()) if 'data' in res else res.get('error')}")
                if "data" in res and res["data"]:
                    print("    Sample Payload:", json.dumps(res["data"], ensure_ascii=False)[:250])

        except Exception as e:
            print("Error in bulk harvest test:", e)
        finally:
            browser.close()

if __name__ == "__main__":
    main()
