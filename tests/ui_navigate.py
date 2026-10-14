#!/usr/bin/env python3
"""
"Go to artist" / "Go to album" in the track menu, and the app's sign-in sheet, driven in Chromium (Playwright).
Not in CI (needs a browser); smoke.py is. Needs: playwright (pip), php, ffmpeg, python3-mutagen.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import *
from playwright.sync_api import sync_playwright

shutil.rmtree(WORK, ignore_errors=True); os.makedirs(WORK)
make_library()
sp = os.path.join(BOX, "Music", "Split Comp")      # a compilation with no album-artist tag: every track is its own "album artist"
ff(os.path.join(sp, "01 - Left.mp3"), dict(title="Left", artist="Alpha", album="Mixtape", track="1"), "libmp3lame", "-b:a", "128k")
ff(os.path.join(sp, "02 - Right.mp3"), dict(title="Right", artist="Beta", album="Mixtape", track="2"), "libmp3lame", "-b:a", "128k", "-write_xing", "0")
start([sys.executable, os.path.join(REPO, "tests", "fake_box.py"), BOX, str(BOX_PORT)])
start(["php", "-S", f"0.0.0.0:{API_PORT}", "-t", REPO], {"SCRAY_AUDIO_DATA_DIR": os.path.join(REPO, "tests", "stub-data"), "SCRAY_AUDIO_TEST_DB": DB})
assert wait_up(f"{API}?action=ping")
scan()
ok = True


def chk(name, cond, extra=""):
    global ok
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "   " + str(extra)))
    ok = ok and bool(cond)


PAGE = f"http://localhost:{API_PORT}/index.php"
URL = f"http://localhost:{API_PORT}"


def menu_for(pg, text, hash_):
    """Open the ⋯ menu of the track row containing `text`."""
    if hash_ is not None:
        pg.goto(PAGE + hash_); pg.wait_for_selector(".trk")
    pg.click(f".trk:has-text('{text}') .dots")
    pg.wait_for_selector(".cmenu .mi")


def pick(pg, label):
    pg.click(f".cmenu .mi:has-text('{label}')"); pg.wait_for_timeout(600)


def view_text(pg):
    return pg.evaluate("document.querySelector('#view').innerText")


try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1100, "height": 800})
        ctx.add_cookies([{"name": "scray_test_session", "value": "1", "url": URL}])
        pg = ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))

        menu_for(pg, "Left", "#/search/Left")
        pick(pg, "Go to album")
        t = view_text(pg)
        chk("Go to album on a compilation with no album-artist tag opens the whole album", "Left" in t and "Right" in t and "2 tracks" in t, t[:200])
        chk("...named for no one in particular", "Various artists" in t, t[:200])

        menu_for(pg, "First", "#/search/First")
        pick(pg, "Go to artist")
        chk("Go to artist opens the artist", pg.evaluate("location.hash") == "#/artist/Artist%20One" and "Album A" in view_text(pg), view_text(pg)[:200])
        pg.click("a.card:has-text('Album A')"); pg.wait_for_selector(".trk")
        chk("an album card still opens by artist and album", "Second" in view_text(pg) and "First" in view_text(pg))

        menu_for(pg, "First", None)
        pick(pg, "Go to album")
        chk("Go to album from an album card's page opens the album", "Second" in view_text(pg) and "First" in view_text(pg))
        menu_for(pg, "First", None)                  # already there: going again still answers (no dead click)
        pg.evaluate("window.scrollTo(0, 50)")
        before = pg.evaluate("location.hash")
        pick(pg, "Go to album")
        chk("...and again from the page you are on", pg.evaluate("location.hash") == before and "Second" in view_text(pg) and pg.evaluate("window.scrollY") == 0)

        menu_for(pg, "Café", "#/search/Caf")
        pick(pg, "Go to album")
        chk("accents and & in names survive", "Café" in view_text(pg) and "Live" in view_text(pg), view_text(pg)[:200])

        menu_for(pg, "loose track", "#/search/loose")
        items = pg.evaluate("[...document.querySelectorAll('.cmenu .mi')].map(e => e.innerText)")
        chk("an untagged track doesn't offer a made-up artist or album", not any("Go to" in i for i in items), items)
        pg.keyboard.press("Escape")

        chk("no page errors", errs == [], errs)
        b.close()

        # ---- the app's sign-in sheet (a pretend app: a boot object, and a pretend Scray api.php)
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 390, "height": 760}, has_touch=True)
        ctx.add_cookies([{"name": "scray_test_session", "value": "1", "url": URL}])
        ctx.add_init_script("window.SCRAY_AUDIO_BOOT = { server: '%s' }; window.webkit = undefined;" % URL)
        KEY = "sd_" + "b" * 64
        calls = []

        def pair(route):
            body = json.loads(route.request.post_data or "{}"); calls.append(body)
            hdr = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"}
            if route.request.method == "OPTIONS":
                return route.fulfill(status=204, headers=hdr)
            if body.get("password") != "pw":
                return route.fulfill(status=401, headers=hdr, content_type="application/json", body=json.dumps({"ok": False, "error": "Wrong password."}))
            if body.get("code") != "123456":
                return route.fulfill(status=401, headers=hdr, content_type="application/json", body=json.dumps({"ok": False, "need_code": True, "error": "Wrong code."} if body.get("code") else {"ok": False, "need_code": True}))
            route.fulfill(status=200, headers=hdr, content_type="application/json", body=json.dumps({"ok": True, "key": KEY, "device": {"name": body.get("name")}}))
        ctx.route("**/scray/api.php**", pair)
        pg = ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(PAGE); pg.wait_for_selector(".sa-card", timeout=5000)
        card = pg.query_selector(".sa-card").bounding_box()
        chk("the sheet is a styled card, not a bare form", 300 < card["width"] <= 360 and pg.evaluate("getComputedStyle(document.querySelector('.sa-veil')).position") == "fixed", card)
        chk("only the password and phone name show at first", pg.is_visible(".sa-card input[type=password]") and not pg.is_visible(".sa-code") and not pg.is_visible(".sa-card input[type=url]"))
        pg.fill(".sa-card input[type=password]", "wrong"); pg.keyboard.press("Enter"); pg.wait_for_timeout(400)
        chk("a wrong password says so", "Wrong password" in pg.inner_text(".sa-err") and not pg.is_visible(".sa-code"), pg.inner_text(".sa-err"))
        pg.fill(".sa-card input[type=password]", "pw"); pg.keyboard.press("Enter"); pg.wait_for_selector(".sa-code", state="visible")
        chk("the right password brings up the code box", pg.evaluate("document.activeElement.classList.contains('sa-code')"))
        pg.type(".sa-code", "123456"); pg.wait_for_function("localStorage.getItem('scrayAudio.deviceKey')", timeout=5000)
        chk("six digits sign in by themselves, and the key is kept", pg.evaluate("localStorage.getItem('scrayAudio.deviceKey')") == KEY)
        chk("the phone name went with it", calls[-1].get("name") == "iPhone" and calls[-1].get("app") == "BBW Sounds", calls[-1])
        pg.wait_for_timeout(1200)
        pg.wait_for_selector("#view")
        pg.click("#dlbtn") if pg.is_visible("#dlbtn") else None
        chk("no page errors (app mode)", errs == [], errs)
        b.close()
finally:
    for pr in procs:
        try:
            os.killpg(os.getpgid(pr.pid), signal.SIGTERM)
        except Exception:
            pass
print("\nall good" if ok else "\nFAILED")
sys.exit(0 if ok else 1)
