#!/usr/bin/env python3
"""
Establish a DBD session through a real browser, and save its cookies.

Why this exists
---------------
DBD sits behind Imperva, which answers plain HTTP clients with a JavaScript
challenge rather than data. Normally that does not matter: a polite crawl from
an address Imperva already trusts is served fine, which is how the collectors
have been running. It matters when the WAF decides otherwise — then every
request returns an HTML 403 and no amount of waiting on the API helps, because
the challenge is never executed.

This runs Chromium, lets it solve the challenge like any visitor's browser
would, and writes the resulting cookies. `DBDClient(cookies=...)` then continues
that same cleared session, so a run can resume without waiting out the block.

It is not a way to go faster or to crawl harder. The rate limits in
dbd_resolve.RateLimiter still apply and still matter: this only restores a
session, it does not raise anyone's tolerance for traffic.

Usage
-----
    python dbd_bootstrap.py --output dbd_cookies.json

Needs a display. On a headless server, run it on a desktop machine and copy the
file across — the cookies are not bound to the host, only to the session.

Requires: pip install playwright playwright-stealth && playwright install chromium
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
logger = logging.getLogger("dbd_bootstrap")

BASE = "https://datawarehouse.dbd.go.th"

# Chromium's own UA, so the header we later send with these cookies matches the
# client that earned them. Imperva ties a cleared session to its user agent.
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def dismiss(page, selector: str) -> None:
    """Close a consent or warning dialog if it happens to be there."""
    try:
        element = page.locator(selector).first
        if element.is_visible(timeout=2000):
            element.click()
            page.wait_for_timeout(500)
    except Exception:
        pass


def bootstrap(headless: bool = False, timeout: int = 60) -> list[dict]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.error("playwright is not installed — "
                     "pip install playwright && playwright install chromium")
        raise

    try:
        from playwright_stealth import Stealth
        stealth = Stealth()
    except ImportError:
        logger.warning("playwright-stealth not installed; Imperva may refuse the browser too")
        stealth = None

    logger.info(f"launching Chromium (headless={headless})")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=headless,
            slow_mo=200,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(
            user_agent=BROWSER_UA,
            viewport={"width": 1440, "height": 900},
            locale="th-TH",
        )
        page = context.new_page()
        if stealth:
            stealth.apply_stealth_sync(page)

        logger.info(f"opening {BASE}")
        try:
            page.goto(f"{BASE}/", wait_until="domcontentloaded", timeout=timeout * 1000)
            time.sleep(5)  # give the Imperva challenge time to run
        except Exception as exc:
            logger.warning(f"navigation problem: {exc}")

        try:
            body = page.inner_text("body")
        except Exception:
            body = ""
        if "Incident ID" in body or "Imperva" in body:
            logger.error("the browser was blocked too — the address itself is being refused, "
                         "so waiting is the only remedy")
        else:
            logger.info("challenge passed; DBD loaded")

        dismiss(page, 'button:has-text("ยอมรับทั้งหมด")')
        dismiss(page, '#btnWarning, button:has-text("ปิด")')

        cookies = []
        for c in context.cookies():
            cookies.append({
                "name": c["name"],
                "value": c["value"],
                "domain": c["domain"],
                "path": c.get("path", "/"),
                "secure": c.get("secure", False),
                "httpOnly": c.get("httpOnly", False),
                # Carried so the API client can send the matching UA.
                "userAgent": BROWSER_UA,
            })
        browser.close()

    imperva = sum(1 for c in cookies if "incap" in c["name"].lower())
    session = sum(1 for c in cookies if "bdw" in c["name"].lower())
    logger.info(f"collected {len(cookies)} cookies ({imperva} Imperva, {session} DBD session)")
    return cookies


def main() -> int:
    ap = argparse.ArgumentParser(description="Save a browser-established DBD session.")
    ap.add_argument("--output", type=Path, default=Path("dbd_cookies.json"))
    ap.add_argument("--headless", action="store_true",
                    help="No visible window. Usually fails a real challenge.")
    ap.add_argument("--verify", action="store_true",
                    help="Try an API call with the cookies before saving them")
    args = ap.parse_args()

    cookies = bootstrap(headless=args.headless)
    if not cookies:
        logger.error("no cookies collected")
        return 1

    if args.verify:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from dbd_client import DBDClient  # noqa: E402
        try:
            DBDClient(cookies=cookies)
            logger.info("✅ cookies work — a token was issued")
        except Exception as exc:
            logger.error(f"cookies did not work: {exc}")
            return 1

    # Session cookies are credentials for as long as they last.
    args.output.write_text(json.dumps(cookies, ensure_ascii=False, indent=1), encoding="utf-8")
    args.output.chmod(0o600)
    logger.info(f"saved to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
