#!/usr/bin/env python3
"""
Obtain a working LandsMaps session: Incapsula cookies plus a usable JWT.

Both are needed and neither can be asked for directly.

The cookies come from a real browser running Incapsula's JavaScript challenge —
which clears by itself in ten to fifteen seconds and needs no human, but does
need a visible window; headless has never cleared it.

The token is the awkward part. Asking `GetJWTAccessToken` on a freshly loaded
page returns `"access_token": null` — the body is a user profile, which is what
made this look like it required an account. The app mints a real token only as
part of performing a search, so this performs one: a scripted province,
district and deed number, and then `searchByParcelNo()`, exactly what a visitor
does. The token is caught as it goes past.

Two details that used to force a human to finish the search by hand:
the district options are labelled `12-สว่างแดนดิน` rather than the bare name, so
they must be chosen by value; and an announcement modal sits over the search
button, swallowing the click. Both are handled here, which is what makes the
run unattended.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger("dol_session")

BASE = "https://landsmaps.dol.go.th"
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# Any real search will mint a token; this one is only a means to that end.
SEED_PROVINCE = "สกลนคร"
SEED_DISTRICT = "สว่างแดนดิน"
SEED_DEED = "70328"

CHALLENGE_TIMEOUT = 90

DISMISS_MODALS = """
() => {
    document.querySelectorAll('.modal').forEach(m => {
        m.classList.remove('show'); m.style.display = 'none';
    });
    document.querySelectorAll('.modal-backdrop').forEach(e => e.remove());
    document.body.classList.remove('modal-open');
    document.body.style.overflow = '';
}
"""


CACHE = "landsmaps_session.json"


@dataclass
class Session:
    token: str
    cookies: list = field(default_factory=list)
    minted_at: float = field(default_factory=time.time)

    def age(self) -> float:
        return time.time() - self.minted_at

    def save(self, path=None) -> None:
        """
        Keep a working session on disk.

        Establishing one costs a browser run and, more to the point, a request
        the gateway may refuse — it stops clearing new sessions after enough of
        them in a short window. So a session that works is worth keeping, and a
        run that is interrupted should not have to earn another.
        """
        from pathlib import Path
        p = Path(path) if path else Path(__file__).resolve().parent / CACHE
        p.write_text(json.dumps({
            "token": self.token, "cookies": self.cookies, "minted_at": self.minted_at,
        }, ensure_ascii=False), encoding="utf-8")
        p.chmod(0o600)   # a live session is a credential
        logger.info(f"session saved to {p.name}")

    @classmethod
    def load(cls, path=None, max_age: float = 20 * 60) -> "Optional[Session]":
        """Reuse a saved session if it is recent enough to be plausibly alive."""
        from pathlib import Path
        p = Path(path) if path else Path(__file__).resolve().parent / CACHE
        if not p.exists():
            return None
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None
        s = cls(token=d["token"], cookies=d.get("cookies", []),
                minted_at=d.get("minted_at", 0))
        if s.age() > max_age:
            logger.info(f"saved session is {s.age()/60:.0f} min old — too old to trust")
            return None
        logger.info(f"reusing saved session ({s.age()/60:.0f} min old)")
        return s

    def requests_session(self):
        import requests
        s = requests.Session()
        s.headers.update({
            "User-Agent": BROWSER_UA,
            "Referer": f"{BASE}/",
            "Authorization": f"Bearer {self.token}",
        })
        for c in self.cookies:
            s.cookies.set(c["name"], c["value"],
                          domain=c.get("domain", ""), path=c.get("path", "/"))
        return s


def _wait_for_challenge(page, timeout: int = CHALLENGE_TIMEOUT) -> bool:
    """
    Leave the browser alone until the real document replaces the challenge.

    Calling the API during that window does not work and appears to cost the
    session — an XHR from a page that has not proved itself is the signature
    these gateways watch for.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if (page.title() or "").strip():
                return True
        except Exception:
            pass
        time.sleep(2)
    return False


def acquire(headless: bool = False, timeout: int = CHALLENGE_TIMEOUT,
            reuse: bool = True) -> Optional[Session]:
    """
    Come back with cookies and a token, reusing a saved session when one is
    still fresh so the gateway is asked as rarely as possible.
    """
    if reuse:
        cached = Session.load()
        if cached is not None:
            return cached
    from playwright.sync_api import sync_playwright
    try:
        from playwright_stealth import Stealth
        stealth = Stealth()
    except ImportError:
        stealth = None
        logger.warning("playwright-stealth missing; the challenge may not clear")

    captured: dict = {}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=headless, args=["--disable-blink-features=AutomationControlled"])
        context = browser.new_context(user_agent=BROWSER_UA,
                                      viewport={"width": 1500, "height": 950}, locale="th-TH")
        page = context.new_page()
        if stealth:
            stealth.apply_stealth_sync(page)

        def on_response(resp):
            if "GetJWTAccessToken" in resp.url and "token" not in captured:
                try:
                    m = re.search(r'"access_token":"([^"]{20,})"', resp.text() or "")
                    if m:
                        captured["token"] = m.group(1)
                except Exception:
                    pass

        page.on("response", on_response)

        try:
            page.goto(f"{BASE}/", wait_until="domcontentloaded", timeout=60000)
            if not _wait_for_challenge(page, timeout):
                logger.error("the Incapsula challenge did not clear")
                return None
            logger.info(f"challenge cleared: {page.title()!r}")
            time.sleep(4)
            page.evaluate(DISMISS_MODALS)
            time.sleep(1)

            page.select_option("#cbprovince", label=SEED_PROVINCE)
            time.sleep(2.5)
            options = page.eval_on_selector_all(
                "#cbamphur option",
                "els => els.map(e => ({v: e.value, t: e.textContent.trim()}))")
            match = [o for o in options if SEED_DISTRICT in o["t"]]
            if not match:
                logger.error(f"district {SEED_DISTRICT} not offered for {SEED_PROVINCE}")
                return None
            page.select_option("#cbamphur", value=match[0]["v"])
            time.sleep(1.5)
            page.fill("#faketxtparcelno", SEED_DEED)
            time.sleep(0.5)
            # The button is what a visitor clicks; calling its handler avoids
            # whatever overlay happens to be in the way today.
            page.evaluate("searchByParcelNo()")

            for _ in range(15):
                if "token" in captured:
                    break
                time.sleep(1)

            cookies = context.cookies()
        finally:
            browser.close()

    if "token" not in captured:
        logger.error("the search did not mint a token")
        return None
    logger.info(f"session acquired (token {len(captured['token'])} chars, "
                f"{len(cookies)} cookies)")
    session = Session(token=captured["token"], cookies=cookies)
    session.save()
    return session


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s [%(levelname)s] %(message)s",
                        datefmt="%Y-%m-%d %H:%M:%S")
    s = acquire()
    print("acquired:", bool(s))
    if s:
        r = s.requests_session().get(
            f"{BASE}/apiService/LandsMaps/GetParcelByParcelNo/47/12/70328", timeout=45)
        print("probe:", r.status_code, (r.text or "")[:160])
