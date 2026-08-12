#!/usr/bin/env python3
"""
Establish a LandsMaps session in a real browser and save its cookies.

DOL sits behind Incapsula, which answers plain HTTP clients with a JavaScript
challenge — and answers it with **HTTP 200 and an HTML body**, so a client that
checks only the status code believes it succeeded. Once a real browser has run
the challenge (about 10–15 seconds), its cookies let ordinary requests through
to both the JSON API and GeoServer, and one session serves thousands of them.

Needs a display, and the challenge rarely clears headless.

    python server/sync/dol_bootstrap.py --output server/sync/landsmaps_cookies.json --verify
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S")
logger = logging.getLogger("dol_bootstrap")

BASE = "https://landsmaps.dol.go.th"
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


def bootstrap(headless: bool = False, timeout: int = 90) -> list[dict]:
    from playwright.sync_api import sync_playwright
    try:
        from playwright_stealth import Stealth
        stealth = Stealth()
    except ImportError:
        stealth = None
        logger.warning("playwright-stealth not installed; the challenge may not clear")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=headless, args=["--disable-blink-features=AutomationControlled"])
        context = browser.new_context(user_agent=BROWSER_UA,
                                      viewport={"width": 1400, "height": 900}, locale="th-TH")
        page = context.new_page()
        if stealth:
            stealth.apply_stealth_sync(page)

        logger.info(f"opening {BASE}")
        page.goto(f"{BASE}/", wait_until="domcontentloaded", timeout=60000)

        # Wait for the challenge to hand over to the real document. Touching the
        # API before that both fails and, from what we have seen, costs the
        # session — so the browser is left alone until the title appears.
        deadline = time.time() + timeout
        cleared = False
        while time.time() < deadline:
            if (page.title() or "").strip():
                cleared = True
                break
            time.sleep(2)
        if not cleared:
            logger.error("the challenge never cleared — try again later, "
                         "or with a visible window if this was headless")
            browser.close()
            return []

        logger.info(f"cleared: {page.title()!r}")
        time.sleep(3)  # let the last cookies settle
        cookies = [{
            "name": c["name"], "value": c["value"], "domain": c["domain"],
            "path": c.get("path", "/"), "secure": c.get("secure", False),
            "httpOnly": c.get("httpOnly", False), "userAgent": BROWSER_UA,
        } for c in context.cookies()]
        browser.close()

    logger.info(f"collected {len(cookies)} cookies "
                f"({sum(1 for c in cookies if 'incap' in c['name'].lower())} Incapsula)")
    return cookies


def session_from_cookies(cookies) -> "requests.Session":
    """A requests session that continues the browser's cleared session."""
    import requests
    if isinstance(cookies, (str, Path)):
        cookies = json.loads(Path(cookies).read_text(encoding="utf-8"))
    s = requests.Session()
    ua = next((c["userAgent"] for c in cookies if c.get("userAgent")), BROWSER_UA)
    s.headers.update({"User-Agent": ua, "Referer": f"{BASE}/"})
    for c in cookies:
        s.cookies.set(c["name"], c["value"], domain=c.get("domain", ""),
                      path=c.get("path", "/"))
    return s


def looks_blocked(text: str) -> bool:
    """Incapsula answers 200 with HTML, so the body is the only honest signal."""
    head = text[:800]
    return "_Incapsula_Resource" in head or "Incident ID" in head


def verify(cookies) -> bool:
    s = session_from_cookies(cookies)
    r = s.get(f"{BASE}/geoserver/LANDSMAPS/wfs", params={
        "service": "WFS", "version": "1.1.0", "request": "GetCapabilities",
    }, timeout=45)
    ok = r.status_code == 200 and not looks_blocked(r.text)
    logger.info(f"verify: HTTP {r.status_code} "
                f"ct={r.headers.get('content-type','')[:40]} "
                f"{'✅ through' if ok else '❌ still blocked'}")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description="Save a browser-established LandsMaps session.")
    ap.add_argument("--output", type=Path,
                    default=Path(__file__).resolve().parent / "landsmaps_cookies.json")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--verify", action="store_true", help="Check the cookies before saving")
    args = ap.parse_args()

    cookies = bootstrap(headless=args.headless)
    if not cookies:
        return 1
    if args.verify and not verify(cookies):
        return 1

    args.output.write_text(json.dumps(cookies, ensure_ascii=False, indent=1), encoding="utf-8")
    args.output.chmod(0o600)
    logger.info(f"saved to {args.output}")
    logger.info("these are short-lived — the session cookie expired within ~30 min last time")
    return 0


if __name__ == "__main__":
    sys.exit(main())
