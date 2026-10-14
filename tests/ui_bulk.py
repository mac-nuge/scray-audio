#!/usr/bin/env python3
"""
The bulk MusicBrainz page (bulk-mb.php) in Chromium (Playwright): start a run with no gateway (the tab drives it),
progress, the list and its filters, a set-aside album, picking a release, undo. Not in CI (needs a browser).
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import *
from bulk_mb import lib
from playwright.sync_api import sync_playwright

shutil.rmtree(WORK, ignore_errors=True); os.makedirs(WORK)
lib()
start([sys.executable, os.path.join(REPO, "tests", "fake_box.py"), BOX, str(BOX_PORT)])
start([sys.executable, os.path.join(REPO, "tests", "fake_mb.py"), str(MB_PORT)])
start(["php", "-S", f"0.0.0.0:{API_PORT}", "-t", REPO], {**PHP_ENV, "SCRAY_AUDIO_TEST_DB": DB})
assert wait_up(f"{API}?action=ping")
scan()
ok = True
URL = f"http://localhost:{API_PORT}"


def chk(name, cond, extra=""):
    global ok
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "   " + str(extra)))
    ok = ok and bool(cond)


try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1400, "height": 900})
        ctx.add_cookies([{"name": "scray_test_session", "value": "1", "url": URL}])
        pg = ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("dialog", lambda d: d.accept())
        pg.goto(URL + "/index.php#/"); pg.wait_for_selector(".folder")
        chk("the library links to the bulk page", pg.locator("#bulkmb").count() == 1)
        pg.goto(URL + "/bulk-mb.php"); pg.wait_for_selector(".tile")
        chk("idle to begin with", pg.inner_text("#mode") == "IDLE")
        pg.click("#startBtn")
        pg.wait_for_function("document.getElementById('mode').textContent === 'RUNNING IN THIS TAB'", timeout=15000)
        chk("no gateway: this tab drives the run, and says so", True)
        pg.wait_for_function("document.getElementById('mode').textContent === 'DONE'", timeout=60000)
        pg.wait_for_timeout(800)
        tiles = pg.evaluate("Object.fromEntries([...document.querySelectorAll('.tile')].map(t => [t.querySelector('span').textContent, t.querySelector('b').textContent]))")
        chk("the tiles add up", tiles["MATCHED"] == "2" and tiles["TO REVIEW"] == "3" and tiles["NOT FOUND"] == "1" and tiles["NO ALBUM TAG"] == "1", tiles)
        chk("the progress bar is full", pg.evaluate("document.getElementById('fill').style.width") == "100%", pg.evaluate("document.getElementById('fill').style.width"))
        chk("the list shows every album", pg.locator("#results tbody tr").count() == 6)
        chk("no stray text under the list", "null" not in pg.inner_text("#results"))
        chk("a folder column, linking to the folder", pg.locator("#results th:has-text('FOLDER')").count() == 1
            and pg.locator("#results td.fold a[href='index.php#/f/Music%2FBand%20X%2FOrigins']").count() == 1)
        pg.click(".tile:has-text('TO REVIEW')"); pg.wait_for_timeout(500)
        chk("a tile filters the list", pg.locator("#results tbody tr").count() == 3 and pg.locator("#seg button.on").inner_text() == "TO REVIEW")
        pg.click("#results tbody tr:has-text('Compilation Two')"); pg.wait_for_timeout(800)
        pg.wait_for_selector(".drawer.on .cand")
        chk("the drawer says why, with both candidates", "different artists" in pg.inner_text(".drawer") and pg.locator(".drawer .cand").count() == 2)
        pg.click(".drawer .cand:has-text('Artist Q') .go"); pg.wait_for_timeout(1200)
        pg.click(".tile:has-text('MATCHED')"); pg.wait_for_timeout(600)
        chk("...and it's matched now", pg.locator("#results tbody tr:has-text('Compilation Two')").count() == 1 and "picked by you" in pg.inner_text("#results"))
        t = [x for x in call("tracks", {"limit": 100})[1]["tracks"] if x["title"] == "Uno"]
        chk("...the tracks got Artist Q's titles", len(t) == 1 and t[0]["albumArtist"] == "Artist Q", t)
        pg.click("#results tbody tr:has-text('Compilation Two')"); pg.wait_for_selector(".drawer.on .stop")
        pg.click(".drawer .stop:has-text('Undo')"); pg.wait_for_timeout(1000)
        chk("Undo from the drawer", any(x["title"] == "One" for x in call("tracks", {"limit": 100})[1]["tracks"]))
        pg.click(".tile:has-text('NOT FOUND')"); pg.wait_for_timeout(500)
        pg.click("#results tbody tr:has-text('Nowhere')"); pg.wait_for_selector(".drawer.on form")
        pg.fill(".drawer input[aria-label=Album]", "Origins"); pg.fill(".drawer input[aria-label=Artist]", "Band X")
        pg.click(".drawer form button"); pg.wait_for_selector(".drawer .cand", timeout=8000)
        chk("search from the drawer lists releases", pg.locator(".drawer .cand").count() >= 2)
        pg.fill("#filter", "band y"); pg.wait_for_timeout(700)
        pg.click(".tile:has-text('ALBUMS')"); pg.wait_for_timeout(600)
        chk("the filter box", pg.locator("#results tbody tr").count() == 1 and "Long Ones" in pg.inner_text("#results"), pg.inner_text("#results")[:300])
        chk("no page errors", errs == [], errs)
        b.close()
finally:
    for pr in procs:
        try:
            os.killpg(os.getpgid(pr.pid), signal.SIGTERM)
        except Exception:
            pass
print("\nall good" if ok else "\nFAILED")
sys.exit(0 if ok else 1)
