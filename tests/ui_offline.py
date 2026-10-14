#!/usr/bin/env python3
"""
The Offline filter and saving tracks, driven in a real browser (Chromium via Playwright) with a pretend
iOS app behind the page: tests/ui_offline.py. The page runs the way the app runs it - from another origin,
signed in with a phone key, with the app's bridge present - so the CORS + key path is exercised too.
Needs: playwright (pip), php, ffmpeg, python3-mutagen. Not in CI (it needs a browser); smoke.py is.
"""
import json, os, sys, urllib.parse
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


def chk(name, cond, extra=""):
    global ok
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "   " + str(extra)))
    ok = ok and bool(cond)


KEY = "sd_" + "a" * 64
PAGE = f"http://localhost:{API_PORT}/index.php"
INIT = """
(() => {
  // a pretend iOS app: files in memory (kept in localStorage so a reload is a restart)
  const load = () => { try { return JSON.parse(localStorage.getItem('__mock') || '{}'); } catch (e) { return {}; } };
  const st = load(); st.files = st.files || {}; st.folder = st.folder || null; st.manifest = st.manifest || null;
  const save = () => localStorage.setItem('__mock', JSON.stringify(st));
  window.__mock = st; window.__played = [];
  window.SCRAY_AUDIO = { app: true, api: 'http://127.0.0.1:%(port)d/api.php', key: '%(key)s', signIn() { window.__signin = true; } };
  const reply = (id, v) => setTimeout(() => window._saResolve(id, v), 5);
  window.webkit = { messageHandlers: { scrayAudio: { postMessage(m) {
    const p = m.payload || {};
    switch (m.action) {
      case 'state': return reply(m.id, { folder: st.folder });
      case 'pickFolder': st.folder = 'Phone music'; save(); return reply(m.id, { folder: st.folder });
      case 'manifestRead': return reply(m.id, st.manifest);
      case 'manifestWrite': st.manifest = p.text; save(); return reply(m.id, true);
      case 'offlineFiles': return reply(m.id, Object.entries(st.files).filter(([k]) => !k.startsWith('.covers/')).map(([path, size]) => ({ path, size })));
      case 'storage': return reply(m.id, { free: 5e9, total: 64e9 });
      case 'download': if (!/^http.*(md5=|action=art&.*s=)/.test(p.url)) return window._saReject(m.id, 'not a signed link: ' + p.url);
        st.files[p.path] = 1000; save(); return setTimeout(() => { window._saProgress('t0', 1000, 1000); window._saResolve(m.id, true); }, 20);
      case 'remove': p.paths.forEach(x => delete st.files[x]); save(); return reply(m.id, true);
      case 'cancel': return reply(m.id, true);
    }
    window._saReject(m.id, 'Unknown action ' + m.action);
  } } } };
  window.__imgs = [];
  const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', { set(v) { window.__imgs.push(v); d.set.call(this, v); }, get() { return d.get.call(this); } });
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__played.push(this.src); return Promise.resolve(); };
})();
""" % {"port": API_PORT, "key": KEY}


def menu_items(pg):
    return pg.eval_on_selector_all(".cmenu .mi", "els => els.map(e => e.querySelector('.ml').textContent)")


try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium" if os.path.exists("/opt/pw-browsers/chromium") else None)
        ctx = b.new_context(viewport={"width": 1200, "height": 800})
        ctx.add_cookies([{"name": "scray_test_session", "value": "1", "url": f"http://localhost:{API_PORT}"}])   # only for the page itself
        ctx.add_init_script(INIT)
        pg = ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("dialog", lambda d: (errs.append("native dialog: " + d.message), d.dismiss()))

        pg.goto(PAGE + "#/album/Artist%20One/Album%20A"); pg.wait_for_selector(".trk")
        chk("the app's page lists tracks through the key (cross-origin, CORS)", pg.locator(".trk").count() == 2)
        chk("the Offline toggle shows in the app", pg.is_visible("#offbtn"))
        pg.wait_for_selector(".cover img[src^='http']", timeout=5000)
        chk("covers load through a signed link", True)

        # ---- save one
        pg.locator(".trk").nth(0).click(button="right")
        items = menu_items(pg); chk("track menu offers Save offline", "Save offline" in items, items)
        pg.click(".cmenu .mi:has-text('Save offline')")
        pg.wait_for_selector(".trk.off", timeout=8000)
        files = pg.evaluate("Object.keys(window.__mock.files)")
        chk("the file lands at <Offline>/<library path>", "Music/Artist One/Album A/01 - First.flac" in files, files)
        chk("the album cover is saved once, under .covers", any(f.startswith(".covers/") for f in files), files)
        chk("only that track is marked saved", pg.locator(".trk.off").count() == 1)
        pg.wait_for_function("window.__mock.manifest && JSON.parse(window.__mock.manifest).tracks.length === 1")
        chk("the list of saved tracks is written to the manifest", True)

        # ---- the filter
        pg.click("#offbtn"); pg.wait_for_selector(".trk")
        chk("Offline filter: the album page shows only what is saved", pg.locator(".trk").count() == 1 and pg.locator(".trk .t").inner_text().endswith("First"), pg.locator(".trk").count())
        pg.goto(PAGE + "#/"); pg.wait_for_selector(".folder")
        names = pg.eval_on_selector_all(".folder .nm", "els => els.map(e => e.textContent)")
        chk("Offline filter: folders show only where saved tracks are", names == ["Music"], names)
        pg.goto(PAGE + "#/artists"); pg.wait_for_selector(".item, .card, .list")
        chk("Offline filter: artists", pg.locator("body").inner_text().count("Artist One") >= 1 and "Various" not in pg.locator("#view").inner_text())
        pg.goto(PAGE + "#/"); pg.wait_for_selector(".folder")      # from Folders, typing goes to the results (on Artists it filters Artists)
        pg.fill("#search", "first"); pg.wait_for_selector(".trk")
        chk("Offline filter: search", pg.locator(".trk").count() == 1)
        pg.fill("#search", "tune"); pg.wait_for_selector(".empty")
        chk("Offline filter: search finds nothing that isn't saved", True)
        pg.fill("#search", ""); pg.wait_for_timeout(500)            # the term would otherwise carry over to the tabs
        pg.goto(PAGE + "#/album/Artist%20One/Album%20A"); pg.wait_for_selector(".trk")
        pg.evaluate("window.__played.length = 0")
        pg.locator(".trk").nth(0).click()
        pg.wait_for_function("window.__played.length > 0")
        played = pg.evaluate("window.__played[window.__played.length - 1]")
        chk("a saved track plays from the phone", played.startswith("scray-audio://local/Music/Artist%20One/Album%20A/01%20-%20First.flac"), played)
        chk("its cover comes from the phone", any(u.startswith("scray-audio://local/.covers/") for u in pg.evaluate("window.__imgs")))

        # ---- restart: the saved list survives
        pg.reload(); pg.wait_for_selector(".trk")
        chk("after a restart the saved track is still saved (and Offline stays on)", pg.locator(".trk.off").count() == 1 and pg.get_attribute("#offbtn", "aria-pressed") == "true")

        # ---- the server goes away: Offline on its own
        pg.click("#offbtn"); pg.wait_for_selector(".trk")
        chk("Offline off: the whole album again", pg.locator(".trk").count() == 2)
        pg.route("**/api.php*", lambda r: r.abort())
        pg.evaluate("location.hash = '#/artists'")
        pg.wait_for_function("document.getElementById('offbtn').getAttribute('aria-pressed') === 'true'", timeout=8000)
        chk("no connection: switches to Offline and says so", "saved on this phone" in pg.inner_text("#toast"), pg.inner_text("#toast"))
        chk("...and still shows the saved artist", "Artist One" in pg.inner_text("#view"), pg.inner_text("#view"))
        pg.unroute("**/api.php*")

        # ---- bulk save and remove
        pg.click("#offbtn"); pg.goto(PAGE + "#/album/Artist%20One/Album%20A"); pg.wait_for_selector(".trk")
        pg.click(".bar .btn:has-text('Offline')"); pg.click(".cmenu .mi:has-text('Remove from offline')")   # one saved: no question asked
        pg.wait_for_function("document.querySelectorAll('.trk.off').length === 0", timeout=8000)
        pg.click(".bar .btn:has-text('Offline')")
        pg.click(".cmenu .mi:has-text('Save offline')")
        pg.wait_for_selector(".dbox"); chk("saving several asks first, with a size", "2 tracks" in pg.inner_text(".dbox"), pg.inner_text(".dbox"))
        pg.click(".dbox button[type=submit]")
        pg.wait_for_function("document.querySelectorAll('.trk.off').length === 2", timeout=8000)
        chk("the whole album is saved", True)

        # ---- edits made elsewhere reach the saved copies at the next start
        import base64 as b64m
        pg.wait_for_function("JSON.parse(window.__mock.manifest).tracks.length === 2", timeout=5000)   # the list is written a moment later
        ids = pg.evaluate("JSON.parse(window.__mock.manifest).tracks.map(t => t.id)")
        call("edit", body={"items": [{"id": ids[0], "set": {"title": "Edited Elsewhere"}}]})
        jpg = open(os.path.join(BOX, "Music", "Artist One", "Album A", "cover.jpg"), "rb").read()
        call("cover_upload", body={"track_ids": ids, "data": b64m.b64encode(jpg + b"\0").decode()})
        pg.reload(); pg.wait_for_selector(".trk")
        pg.wait_for_function("JSON.parse(window.__mock.manifest).tracks.some(t => t.title === 'Edited Elsewhere')", timeout=8000)
        files = pg.evaluate("Object.keys(window.__mock.files)")
        covers = [f for f in files if f.startswith(".covers/")]
        chk("a saved track takes on an edit made elsewhere", True)
        chk("...and swaps its cover for the new one (the old one removed)", len(covers) == 1 and "@" in covers[0], covers)
        pg.click("#offbtn"); pg.wait_for_selector(".trk")
        chk("...which Offline mode shows", "Edited Elsewhere" in pg.inner_text("#view"))
        pg.click("#offbtn"); pg.wait_for_selector(".trk")
        pg.click(".bar .btn:has-text('Offline')"); pg.click(".cmenu .mi:has-text('Remove from offline')")
        pg.wait_for_selector(".dbox"); pg.click(".dbox button[type=submit]")
        pg.wait_for_function("document.querySelectorAll('.trk.off').length === 0", timeout=8000)
        files = pg.evaluate("Object.keys(window.__mock.files)")
        chk("removing deletes the files and the cover", files == [], files)
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
