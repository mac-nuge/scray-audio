#!/usr/bin/env python3
"""
History in Chromium (Playwright): a play counts after it has been heard (half of these 3 s tracks), shows in the
History panel with the device, a play while the server can't be reached waits and is sent later, remove, clear.
Also the header link to the bulk MusicBrainz page. Not in CI (needs a browser).
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import *
from playwright.sync_api import sync_playwright

shutil.rmtree(WORK, ignore_errors=True); os.makedirs(WORK)
make_library()
start([sys.executable, os.path.join(REPO, "tests", "fake_box.py"), BOX, str(BOX_PORT)])
start(["php", "-S", f"0.0.0.0:{API_PORT}", "-t", REPO], {**PHP_ENV, "SCRAY_AUDIO_TEST_DB": DB})
assert wait_up(f"{API}?action=ping")
scan()
ok = True
URL = f"http://localhost:{API_PORT}"; PAGE = URL + "/index.php"


def chk(name, cond, extra=""):
    global ok
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "   " + str(extra)))
    ok = ok and bool(cond)


hist = lambda: call("history")[1]


def open_hist(pg):
    if pg.is_hidden("#histpanel"):
        pg.click("#bhist")
    pg.wait_for_selector("#hlist li.pl")
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        ctx = b.new_context(viewport={"width": 1200, "height": 850})
        ctx.add_cookies([{"name": "scray_test_session", "value": "1", "url": URL}])
        pg = ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(PAGE + "#/album/Artist%20One/Album%20A"); pg.wait_for_selector(".trk")
        chk("the header links to the bulk MusicBrainz page", pg.is_visible("#mbbtn") and pg.get_attribute("#mbbtn", "href") == "bulk-mb.php")

        pg.click(".trk:has-text('First')")
        pg.wait_for_function("document.querySelector('audio') || true")
        pg.wait_for_timeout(600); pg.click("#bnext")                 # under half of a 3 s track: not a play
        pg.wait_for_timeout(2600)                                     # Second plays on past half
        h1 = hist()
        chk("a track heard past half counts; one skipped early doesn't", [x["was"]["title"] for x in h1["plays"]] == ["Second"] and h1["plays"][0]["device"] == "Computer", str(h1)[:300])
        open_hist(pg)
        chk("the History panel lists it under Today", pg.inner_text("#hlist li.day") .lower() == "today" and "Second" in pg.inner_text("#hlist"))
        chk("...and the queue panel isn't open at the same time", pg.is_hidden("#queuepanel"))

        # the server can't be reached: the play waits on this device, then goes
        pg.route("**/api.php?action=play_log*", lambda r: r.abort())
        pg.goto(PAGE + "#/album/Various%20Artists/Compilation"); pg.wait_for_selector(".trk")
        pg.click(".trk:has-text('Tune')"); pg.wait_for_timeout(2400); pg.evaluate("document.querySelector('#bplay').click()")
        open_hist(pg)
        chk("offline: the play shows as not sent yet", "not sent yet" in pg.inner_text("#hlist") and len(hist()["plays"]) == 1, pg.inner_text("#hlist")[:300])
        pg.reload(); pg.wait_for_selector(".trk")
        chk("...and survives a reload", "Tune" in pg.evaluate("localStorage.getItem('scrayAudio.playsPending') || ''"))
        pg.unroute("**/api.php?action=play_log*")
        pg.evaluate("window.dispatchEvent(new Event('online'))"); pg.wait_for_timeout(800)
        chk("back online: it's sent, once", [x["was"]["title"] for x in hist()["plays"]] == ["Tune", "Second"]
            and pg.evaluate("JSON.parse(localStorage.getItem('scrayAudio.playsPending'))") == [])

        open_hist(pg)
        pg.click("#hlist li.pl:has-text('Second')"); pg.wait_for_timeout(500)
        chk("a tap in History plays it", pg.inner_text("#nptitle") == "Second")
        pg.evaluate("document.querySelector('audio') ; [...document.querySelectorAll('audio')].forEach(a => a.pause())")
        pg.click("#bplay") if pg.inner_text("#bplay") == "⏸" else None
        pg.wait_for_timeout(300)
        open_hist(pg)
        pg.click("#hlist li.pl:has-text('Tune') .h-m"); pg.wait_for_selector(".cmenu")
        pg.click(".cmenu .mi:has-text('Remove from history')"); pg.wait_for_timeout(600)
        chk("remove one from History", [x["was"]["title"] for x in hist()["plays"]] and "Tune" not in [x["was"]["title"] for x in hist()["plays"]])
        pg.click("#hclear"); pg.wait_for_selector(".dbox .btn.go"); pg.click(".dbox .btn.go"); pg.wait_for_timeout(600)
        chk("clear", hist()["total"] == 0 and "Nothing played yet" in pg.inner_text("#hlist"))
        chk("no page errors", errs == [], errs)
        b.close()

        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 390, "height": 800}, has_touch=True, is_mobile=True)
        ctx.add_cookies([{"name": "scray_test_session", "value": "1", "url": URL}])
        pg = ctx.new_page(); pg.goto(PAGE); pg.wait_for_selector(".folder")
        chk("on a phone the MusicBrainz link stays out of the way", pg.is_hidden("#mbbtn") and pg.is_visible("#bhist"))
        b.close()
finally:
    for pr in procs:
        try:
            os.killpg(os.getpgid(pr.pid), signal.SIGTERM)
        except Exception:
            pass
print("\nall good" if ok else "\nFAILED")
sys.exit(0 if ok else 1)
