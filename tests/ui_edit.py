#!/usr/bin/env python3
"""
Editing in the page, in Chromium (Playwright): a track's details, an album, MusicBrainz matching, covers.
Not in CI (needs a browser); smoke.py covers the api. Needs: playwright (pip), php, ffmpeg, python3-mutagen.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import *
from playwright.sync_api import sync_playwright

shutil.rmtree(WORK, ignore_errors=True); os.makedirs(WORK)
make_library()
start([sys.executable, os.path.join(REPO, "tests", "fake_box.py"), BOX, str(BOX_PORT)])
start([sys.executable, os.path.join(REPO, "tests", "fake_mb.py"), str(MB_PORT)])
start(["php", "-S", f"0.0.0.0:{API_PORT}", "-t", REPO], {**PHP_ENV, "SCRAY_AUDIO_TEST_DB": DB})
assert wait_up(f"{API}?action=ping")
scan()
byname = {t["title"]: t["id"] for t in call("tracks")[1]["tracks"]}
ok = True
URL = f"http://localhost:{API_PORT}"; PAGE = URL + "/index.php"


def chk(name, cond, extra=""):
    global ok
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "   " + str(extra)))
    ok = ok and bool(cond)


titles = "[...document.querySelectorAll('#view .trk .t')].map(e => e.textContent.trim())"
try:
    with sync_playwright() as p:
        for mobile in (False, True):
            print("phone" if mobile else "desktop")
            call("edit_reset", body={"track_ids": list(range(1, 20))})
            b = p.chromium.launch()
            ctx = b.new_context(**({"viewport": {"width": 390, "height": 800}, "has_touch": True, "is_mobile": True} if mobile else {"viewport": {"width": 1200, "height": 900}}))
            ctx.add_cookies([{"name": "scray_test_session", "value": "1", "url": URL}])
            pg = ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            tap = (lambda sel: pg.tap(sel)) if mobile else (lambda sel: pg.click(sel))

            # one track
            pg.goto(PAGE + "#/album/Artist%20One/Album%20A"); pg.wait_for_selector(".trk")
            tap(".trk:has-text('Second') .dots"); pg.wait_for_selector(".cmenu")
            tap(".cmenu .mi:has-text('Edit details')"); pg.wait_for_selector(".sheet .dinput")
            chk("the form opens with what the track says", pg.input_value(".sheet input[aria-label=Title]") == "Second" and pg.input_value(".sheet input[aria-label=Year]") == "1999")
            pg.fill(".sheet input[aria-label=Title]", "Second Coming")
            chk("a changed field says what the file has", "File: Second" in pg.inner_text(".sheet"))
            pg.fill(".sheet input[aria-label=Genre]", "Drone")
            tap(".sheet .btn.go"); pg.wait_for_selector(".sheet", state="detached"); pg.wait_for_timeout(500)
            chk("saved: the list shows the new title", "Second Coming" in pg.evaluate(titles), pg.evaluate(titles))
            tap(".trk:has-text('Second Coming') .dots"); pg.wait_for_selector(".cmenu"); tap(".cmenu .mi:has-text('Edit details')"); pg.wait_for_selector(".sheet .dinput")
            tap(".sheet label:has(input[aria-label=Title]) .eback")
            chk("↺ puts the file's value back in the box", pg.input_value(".sheet input[aria-label=Title]") == "Second")
            tap(".sheet .btn.go"); pg.wait_for_selector(".sheet", state="detached"); pg.wait_for_timeout(500)
            chk("...and saving that drops the edit", "Second" in pg.evaluate(titles) and call("track_info", {"id": byname["Second"]})[1]["edits"].get("title") is None)

            # cover upload
            tap(".trk:has-text('Second') .dots"); pg.wait_for_selector(".cmenu"); tap(".cmenu .mi:has-text('Edit details')"); pg.wait_for_selector(".sheet .dinput")
            with pg.expect_file_chooser() as fc:
                tap(".sheet .ecbtns .btn:has-text('Upload')")
            fc.value.set_files(os.path.join(BOX, "Music", "Artist One", "Album A", "cover.jpg"))
            pg.wait_for_selector(".sheet", state="detached", timeout=8000); pg.wait_for_timeout(400)
            t2 = call("tracks_by_id", body={"ids": [byname["Second"]]})[1]["tracks"][0]
            chk("an uploaded cover is the track's now", t2["coverv"] not in ("", "f"), t2)

            # the album
            pg.goto(PAGE + "#/album/Various%20Artists/Compilation"); pg.wait_for_selector(".trk")
            tap(".bar .btn:has-text('Edit')"); pg.wait_for_selector(".sheet .etr")
            pg.fill(".sheet input[aria-label=Album]", "Compiled")
            pg.fill(".sheet input[aria-label=Year]", "2006")
            pg.locator(".sheet .etr input[aria-label=Title]").nth(1).fill("The Other One")
            tap(".sheet .btn.go"); pg.wait_for_selector(".sheet", state="detached"); pg.wait_for_timeout(800)
            chk("a renamed album: the page follows it", "Compiled" in pg.inner_text("h1.title") and "2006" in pg.inner_text(".subtitle") and "The Other One" in pg.evaluate(titles), pg.evaluate("location.hash"))
            pg.goto(PAGE + "#/albums"); pg.wait_for_selector(".card")
            chk("...and the albums list has the new name", "Compiled" in pg.inner_text("#view") and "Compilation" not in pg.inner_text("#view"))
            tap(".card:has-text('Compiled')"); pg.wait_for_selector(".trk")
            tap(".bar .btn:has-text('Edit')"); pg.wait_for_selector(".sheet .etr")
            tap(".sheet .btn:has-text('Back to the files')"); pg.wait_for_selector(".dbox:not(.sheet) .btn.go")
            tap(".dbox:not(.sheet) .btn.go"); pg.wait_for_timeout(900)
            chk("undo all: back to the files' tags", "Compilation" in pg.inner_text("h1.title") and "Other" in pg.evaluate(titles), pg.inner_text("h1.title"))

            # MusicBrainz
            pg.goto(PAGE + "#/album/Artist%20One/Album%20A"); pg.wait_for_selector(".trk")
            tap(".bar .btn:has-text('MusicBrainz')"); pg.wait_for_selector(".mbrel")
            chk("it searches by itself and lists releases, the 2-track one marked", pg.locator(".mbrel").count() == 2 and pg.locator(".mbrel.fit").count() == 1)
            tap(".mbrel.fit"); pg.wait_for_selector(".mbtable")
            txt = pg.inner_text(".mbtable")
            chk("the preview shows old → new", "First Light" in txt and "Second Wind" in txt and "Artist One feat. Guest" in txt, txt)
            chk("no stray text in the preview", "null" not in pg.inner_text(".sheet .sbody"))
            chk("year choices: first released and this release", pg.evaluate("[...document.querySelectorAll('.mbyear option')].map(o => o.value)") == ["1998", "1999"])
            pg.check(".mbopts input[data-k=cover]")
            tap(".sheet .dbtns .btn.go"); pg.wait_for_selector(".sheet", state="detached", timeout=8000); pg.wait_for_timeout(900)
            chk("applied: titles, album and cover", pg.evaluate(titles) == ["First Light", "Second Wind"] and "Album A (Remastered)" in pg.inner_text("h1.title"), pg.evaluate(titles))
            i = call("track_info", {"id": byname["First"]})[1]
            chk("...marked as from MusicBrainz", i["edits"]["title"]["source"] == "musicbrainz" and i["mb"]["release"].startswith("1111") and i["track"]["coverv"] not in ("", "f"), str(i)[:300])
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
