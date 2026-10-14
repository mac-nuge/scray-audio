#!/usr/bin/env python3
"""
Queueing, playing an album from a track, Liked, and the search term carried across the tabs, in Chromium (Playwright).
Not in CI (needs a browser); smoke.py is. Needs: playwright (pip), php, ffmpeg, python3-mutagen.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import *
from playwright.sync_api import sync_playwright

shutil.rmtree(WORK, ignore_errors=True); os.makedirs(WORK)
make_library()
a3 = os.path.join(BOX, "Music", "Artist One", "Album A")
ff(os.path.join(a3, "03 - Third.flac"), dict(title="Third", artist="Artist One", album="Album A", track="3/3", date="1999", genre="Ambient"), "flac")
start([sys.executable, os.path.join(REPO, "tests", "fake_box.py"), BOX, str(BOX_PORT)])
start(["php", "-S", f"0.0.0.0:{API_PORT}", "-t", REPO], {"SCRAY_AUDIO_DATA_DIR": os.path.join(REPO, "tests", "stub-data"), "SCRAY_AUDIO_TEST_DB": DB})
assert wait_up(f"{API}?action=ping")
scan()
ok = True
URL = f"http://localhost:{API_PORT}"; PAGE = URL + "/index.php"


def chk(name, cond, extra=""):
    global ok
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "   " + str(extra)))
    ok = ok and bool(cond)


QUEUE = "(() => [...document.querySelectorAll('#qlist li .q-t b')].map(e => e.textContent))()"

try:
    with sync_playwright() as p:
        for mobile in (False, True):
            print("phone" if mobile else "desktop")
            b = p.chromium.launch()
            ctx = b.new_context(**({"viewport": {"width": 390, "height": 800}, "has_touch": True, "is_mobile": True} if mobile else {"viewport": {"width": 1200, "height": 850}}))
            ctx.add_cookies([{"name": "scray_test_session", "value": "1", "url": URL}])
            pg = ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            tap = (lambda sel: pg.tap(sel)) if mobile else (lambda sel: pg.click(sel))
            pg.goto(PAGE + "#/"); pg.wait_for_selector(".folder")
            pg.evaluate("sessionStorage.clear()")
            if not mobile:
                # the server's Liked starts empty for this run
                pg.evaluate("fetch('api.php?action=liked').then(r => r.json()).then(j => j.ids.length && fetch('api.php?action=like', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({track_ids: j.ids, on: false})}))")
                pg.wait_for_timeout(300)

            # 1. a track in an album, with shuffle left on: that track then the rest of the album, in order
            pg.evaluate("localStorage.setItem('scrayAudio.shuffle', 'true')"); pg.goto(PAGE + "#/album/Artist%20One/Album%20A"); pg.reload(); pg.wait_for_selector(".trk")
            chk("shuffle was on", pg.get_attribute("#bshuffle", "aria-pressed") == "true")
            tap(".trk:has-text('Second')"); pg.wait_for_timeout(400)
            tap("#bqueue"); pg.wait_for_timeout(200)
            q = pg.evaluate(QUEUE)
            chk("a tap in an album queues the album in order from that track", q == ["First", "Second", "Third"] and pg.inner_text("#nptitle") == "Second", q)
            chk("...with shuffle off", pg.get_attribute("#bshuffle", "aria-pressed") == "false")
            tap("#qclose")
            pg.goto(PAGE + "#/f/" + "Music%2FArtist%20One%2FAlbum%20A"); pg.wait_for_selector(".trk")
            tap(".trk:has-text('Third')"); pg.wait_for_timeout(300)
            chk("a tap in a folder plays from there", pg.inner_text("#nptitle") == "Third")

            # 2. add to queue: the bar, an album card, a folder, a track
            pg.goto(PAGE + "#/albums"); pg.wait_for_selector(".card")
            tap(".card:has-text('Compilation') .cb[title='Add to queue']"); pg.wait_for_timeout(400)
            chk("an album card's + adds the album to the queue", "Added 2 tracks" in pg.inner_text("#toast") and pg.evaluate("location.hash") == "#/albums", pg.inner_text("#toast"))
            pg.goto(PAGE + "#/f/Music"); pg.wait_for_selector(".folder")
            tap(".folder:has-text('Singles') .pl[title='Add this folder to the queue']"); pg.wait_for_timeout(400)
            chk("a folder's + adds it", "Added 1 track" in pg.inner_text("#toast"), pg.inner_text("#toast"))
            pg.goto(PAGE + "#/genre/Pop"); pg.wait_for_selector(".trk")
            tap(".bar .btn:has-text('Queue')"); pg.wait_for_timeout(400)
            tap("#bqueue"); pg.wait_for_timeout(200)
            q = pg.evaluate(QUEUE)
            chk("＋ Queue adds the whole list at the end", q[-5:] == ["Tune", "Other", "loose track", "Tune", "Other"], q)
            tap("#qclose")

            # 3. likes
            pg.goto(PAGE + "#/search/First"); pg.wait_for_selector(".trk")
            tap(".trk:has-text('First') .lk"); pg.wait_for_timeout(500)
            chk("♡ on a track likes it", pg.inner_text(".trk:has-text('First') .lk") == "♥")
            pg.goto(PAGE + "#/album/Various%20Artists/Compilation"); pg.wait_for_selector(".trk")
            tap(".bar .btn:has-text('Like')"); pg.wait_for_timeout(500)
            chk("♡ Like on an album likes every track", pg.evaluate("[...document.querySelectorAll('.trk .lk')].every(b => b.textContent === '♥')"))
            pg.fill("#search", ""); pg.wait_for_timeout(600)              # the search above left a term behind
            pg.goto(PAGE + "#/playlists"); pg.wait_for_selector(".plrow")
            first = pg.inner_text(".plrow >> nth=0")
            chk("Liked is first in Playlists, with the count", "Liked" in first and "3 tracks" in first, first)
            tap(".plrow >> nth=0"); pg.wait_for_selector(".trk")
            chk("Liked lists them, newest first", pg.evaluate("[...document.querySelectorAll('.trk .t')].map(e => e.textContent.trim())") == ["Tune", "Other", "First"])
            chk("Liked can't be renamed or deleted from its page", not pg.query_selector(".bar .btn:has-text('Rename')") and not pg.query_selector(".bar .btn:has-text('Delete')"))
            tap(".trk:has-text('Other') .dots"); pg.wait_for_selector(".cmenu")
            tap(".cmenu .mi:has-text('Remove from Liked')"); pg.wait_for_timeout(700)
            chk("Remove from Liked takes it off the list", pg.evaluate("[...document.querySelectorAll('.trk .t')].map(e => e.textContent.trim())") == ["Tune", "First"])
            tap(".trk:has-text('Tune')"); pg.wait_for_timeout(400)
            chk("the now-playing heart shows liked", pg.inner_text("#nplike") == "♥")
            tap("#nplike"); pg.wait_for_timeout(600)
            chk("...and unlikes from there too", pg.inner_text("#nplike") == "♡" and "Tune" not in pg.inner_text("#view"))
            # put the server back for the next pass
            pg.evaluate("fetch('api.php?action=liked').then(r => r.json()).then(j => j.ids.length && fetch('api.php?action=like', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({track_ids: j.ids, on: false})}))")
            pg.wait_for_timeout(300)

            # 4. the search term carries across the tabs
            pg.goto(PAGE + "#/"); pg.wait_for_selector(".folder")
            pg.fill("#search", "one"); pg.wait_for_function("location.hash === '#/search/one'", timeout=3000)
            chk("typing goes to the results", "Artist One" in pg.inner_text("#view") and pg.is_visible("#tabres"))
            tap("#tabs a[data-tab=artists]"); pg.wait_for_timeout(500)
            arts = pg.evaluate("[...document.querySelectorAll('#view .item .nm')].map(e => e.textContent)")
            chk("Artists keeps the term and shows the matching artists", pg.input_value("#search") == "one" and arts == ["Artist One"], arts)
            tap("#tabs a[data-tab=albums]"); pg.wait_for_timeout(500)
            al = pg.evaluate("[...document.querySelectorAll('#view .card .cn')].map(e => e.textContent)")
            chk("Albums: the albums matching", al == ["Album A"] and "matching “one”" in pg.inner_text("#view"), al)
            tap("#tabs a[data-tab=folders]"); pg.wait_for_timeout(500)
            fo = pg.evaluate("[...document.querySelectorAll('#view .folder .nm')].map(e => e.firstChild.textContent)")
            chk("Folders: the folders matching", fo == ["Artist One"], fo)
            tap("#tabs a[data-tab=albums]"); pg.wait_for_timeout(400)
            pg.fill("#search", "compil"); pg.wait_for_timeout(700)
            al = pg.evaluate("[...document.querySelectorAll('#view .card .cn')].map(e => e.textContent)")
            chk("typing on a tab filters it in place", pg.evaluate("location.hash") == "#/albums" and al == ["Compilation"], al)
            tap(".card:has-text('Compilation')"); pg.wait_for_selector(".trk")
            chk("an album opens whole, the term still in the box", len(pg.query_selector_all(".trk")) == 2 and pg.input_value("#search") == "compil")
            tap("#tabs a[data-tab=albums]"); pg.wait_for_timeout(400)
            tap(".fnote .lnk"); pg.wait_for_timeout(500)
            chk("Show all clears the term", pg.input_value("#search") == "" and not pg.is_visible("#tabres") and len(pg.query_selector_all("#view .card")) == 3)
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
