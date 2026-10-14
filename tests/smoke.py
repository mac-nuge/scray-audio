#!/usr/bin/env python3
"""
End-to-end smoke test: no network, no real box.

  python3 tests/smoke.py

Makes a few tiny audio files with ffmpeg, starts the fake box+gateway
(tests/fake_box.py) and `php -S` for the real api.php (with the stub auth in
tests/stub-data), runs the real scanner against them, then checks what the api
says - including that a signed URL plays, seeks, and a forged one is refused.
Needs: php, python3-mutagen, ffmpeg.
"""
import base64, hashlib, json, os, shutil, signal, sqlite3, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(REPO, "tests", ".work")
BOX = os.path.join(WORK, "box")
DB = os.path.join(WORK, "audio.sqlite")
API_PORT, BOX_PORT, MB_PORT = 8098, 8099, 8097
# what php -S needs, besides the database: covers in the work folder, MusicBrainz and the Cover Art Archive faked
PHP_ENV = {"SCRAY_AUDIO_DATA_DIR": os.path.join(REPO, "tests", "stub-data"), "SCRAY_AUDIO_COVERS_DIR": os.path.join(WORK, "covers"),
           "SCRAY_AUDIO_MB_BASE": f"http://127.0.0.1:{MB_PORT}/ws/2", "SCRAY_AUDIO_CAA_BASE": f"http://127.0.0.1:{MB_PORT}"}
API = f"http://127.0.0.1:{API_PORT}/api.php"
procs = []
fails = []


def check(name, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + name + (f"   {extra}" if extra and not cond else ""))
    if not cond:
        fails.append(name)


def ff(out, tags, codec, *more):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3"]
    for k, v in tags.items():
        cmd += ["-metadata", f"{k}={v}"]
    subprocess.run(cmd + ["-codec:a", codec, *more, out], check=True)


def make_library():
    shutil.rmtree(BOX, ignore_errors=True)
    a = os.path.join(BOX, "Music", "Artist One", "Album A")
    ff(os.path.join(a, "02 - Second.flac"), dict(title="Second", artist="Artist One", album="Album A", track="2/2", date="1999", genre="Ambient"), "flac")
    ff(os.path.join(a, "01 - First.flac"), dict(title="First", artist="Artist One", album="Album A", track="1/2", date="1999", genre="Ambient"), "flac")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", os.path.join(a, "cover.jpg")], check=True)
    v = os.path.join(BOX, "Music", "Various", "Compilation")
    ff(os.path.join(v, "01 - Tune.mp3"), dict(title="Tune", artist="Someone", album_artist="Various Artists", album="Compilation", track="1", date="2005", genre="Pop"), "libmp3lame", "-b:a", "128k")
    ff(os.path.join(v, "02 - Other.mp3"), dict(title="Other", artist="Someone Else", album_artist="Various Artists", album="Compilation", track="2", date="2005", genre="Pop"), "libmp3lame", "-b:a", "128k", "-write_xing", "0")
    ff(os.path.join(BOX, "Music", "Singles", "loose track.mp3"), {}, "libmp3lame", "-b:a", "128k")
    ff(os.path.join(BOX, "Music", "Édith & Co's", "Café – live.mp3"), dict(title="Café", artist="Édith", album="Live", date="1960"), "libmp3lame", "-b:a", "128k")
    open(os.path.join(BOX, "Music", "notes.txt"), "w").write("not audio")
    open(os.path.join(BOX, "Music", ".hidden.mp3"), "w").write("skip me")


def start(cmd, env=None):
    p = subprocess.Popen(cmd, env={**os.environ, **(env or {})}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
    procs.append(p)
    return p


def wait_up(url, tries=50):
    for _ in range(tries):
        try:
            urllib.request.urlopen(url, timeout=1)
            return True
        except urllib.error.HTTPError:
            return True
        except Exception:
            time.sleep(0.1)
    return False


def call(action, params=None, cookie=True, key=None, body=None, worker=None, b64=False):
    q = urllib.parse.urlencode({"action": action, **(params or {})})
    h = {}
    if cookie:
        h["Cookie"] = "scray_test_session=1"
    if key:
        h["X-Scray-Key"] = key
    if worker:
        h["X-Scray-Worker"] = worker
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
        if b64:
            data = base64.b64encode(data)
            h["X-Scray-Enc"] = "b64"
            h["Content-Type"] = "text/plain"
    req = urllib.request.Request(f"{API}?{q}", data=data, headers=h, method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


SCANNER = os.path.join(REPO, "gateway", "scray-audio-scan.py")


def scan(extra_env=None, args=()):
    env = {**os.environ, "SCRAY_AUDIO_API": API, "SCRAY_AUDIO_WORKER_KEY": "test-worker-key",
           "SCRAY_DAV_URL": f"http://127.0.0.1:{BOX_PORT}", "SCRAY_DAV_USER": "scan", "SCRAY_DAV_PASS": "pw", **(extra_env or {})}
    r = subprocess.run([sys.executable, SCANNER, *args], env=env, capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def main():
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK)
    print("making a little library")
    make_library()
    start([sys.executable, os.path.join(REPO, "tests", "fake_box.py"), BOX, str(BOX_PORT)])
    start([sys.executable, os.path.join(REPO, "tests", "fake_mb.py"), str(MB_PORT)])
    start(["php", "-S", f"127.0.0.1:{API_PORT}", "-t", REPO], {**PHP_ENV, "SCRAY_AUDIO_TEST_DB": DB})
    assert wait_up(f"{API}?action=ping") and wait_up(f"http://127.0.0.1:{BOX_PORT}/x"), "servers did not start"

    print("base64 bodies (so a firewall has nothing to match on)")
    st, j = call("audio_worker_start", cookie=False, worker="test-worker-key", body={}, b64=True)
    assert st == 200 and j.get("scan_id"), (st, j)
    st, j = call("audio_worker_seen", cookie=False, worker="test-worker-key", b64=True,
                 body={"scan_id": j["scan_id"], "files": [{"path": "A/x../select * from x/<b>.mp3", "size": 1, "etag": "e", "mtime": 1, "cover": ""}]})
    assert st == 200 and j.get("seen") == 1, (st, j)
    st, j = call("audio_worker_seen", cookie=False, worker="test-worker-key", body={"scan_id": 1, "files": []}, b64=False)
    assert st == 200, "plain JSON bodies must still work"

    print("auth")
    check("ping needs nothing", call("ping", cookie=False)[0] == 200)
    check("no session, no data", call("stats", cookie=False)[0] == 401)
    check("console key is accepted", call("stats", cookie=False, key="test-admin")[0] == 200)
    DEV = "sd_" + "a" * 64
    check("a paired phone's key is accepted", call("stats", cookie=False, key=DEV)[0] == 200)
    check("a well-formed key that was never issued is refused", call("stats", cookie=False, key="sd_" + "b" * 64)[0] == 401)
    check("a phone key can't use worker actions", call("audio_worker_start", cookie=False, key=DEV, body={})[0] == 401)
    req = urllib.request.Request(API + "?action=stats", method="OPTIONS", headers={"Origin": "file://", "Access-Control-Request-Headers": "x-scray-key"})
    with urllib.request.urlopen(req) as r:
        check("CORS preflight answers 204 with the key header allowed", r.status == 204 and "X-Scray-Key" in r.headers.get("Access-Control-Allow-Headers", ""))
    check("the scanner key is not a session", call("stats", cookie=False, worker="test-worker-key")[0] == 401)
    check("a bad worker key is refused", call("audio_worker_start", cookie=False, worker="nope", body={})[0] == 401)
    check("a session can't use worker actions", call("audio_worker_start", body={})[0] == 401)

    print("scanning")
    code, out = scan()
    print("   " + out.strip().splitlines()[-1])
    check("scan exits 0", code == 0, out)
    s = call("stats")[1]
    check("6 audio files found (not the txt, not the dotfile)", s["tracks"] == 6, str(s))
    check("none left untagged", s["untagged"] == 0, str(s))

    code, out2 = scan()
    check("rescan runs", code == 0, out2)
    check("rescan reads no tags (nothing changed)", "6 files, 0 tagged" in out2, out2)

    print("folders")
    ls = call("ls")[1]
    check("root has Music", [f["name"] for f in ls["folders"]] == ["Music"] and ls["folders"][0]["tracks"] == 6, str(ls["folders"]))
    ls = call("ls", {"path": "Music"})[1]
    names = [f["name"] for f in ls["folders"]]
    check("sub-folders, natural order", names == ["Artist One", "Singles", "Various", "Édith & Co's"], str(names))
    ls = call("ls", {"path": "Music/Artist One/Album A"})[1]
    check("tracks in track order", [t["title"] for t in ls["tracks"]] == ["First", "Second"], str(ls["tracks"]))
    check("folder art found", ls["art"] is not None)
    check("track facts", ls["tracks"][0]["year"] == 1999 and ls["tracks"][0]["genre"] == "Ambient" and ls["tracks"][0]["no"] == 1 and 2900 < ls["tracks"][0]["ms"] < 3100, str(ls["tracks"][0]))
    ls = call("ls", {"path": "Music/Édith & Co's"})[1]
    check("non-ASCII folder and file", len(ls["tracks"]) == 1 and ls["tracks"][0]["title"] == "Café", str(ls))
    ls = call("ls", {"path": "Music/Singles"})[1]
    check("untagged file falls back to its name", ls["tracks"][0]["title"] == "loose track" and ls["tracks"][0]["albumArtist"] == "Unknown artist", str(ls["tracks"]))

    print("metadata views")
    artists = [a["name"] for a in call("artists")[1]["artists"]]
    check("artists", artists == ["Artist One", "Édith", "Unknown artist", "Various Artists"] or sorted(artists) == sorted(["Artist One", "Édith", "Unknown artist", "Various Artists"]), str(artists))
    albums = call("albums")[1]["albums"]
    check("albums skip the loose tracks", sorted(a["album"] for a in albums) == ["Album A", "Compilation", "Live"], str(albums))
    comp = [a for a in albums if a["album"] == "Compilation"][0]
    check("compilation grouped under its album artist", comp["artist"] == "Various Artists" and comp["tracks"] == 2, str(comp))
    t = call("tracks", {"artist": "Various Artists", "album": "Compilation"})[1]["tracks"]
    check("album tracks in order, with their own artists", [(x["title"], x["artist"]) for x in t] == [("Tune", "Someone"), ("Other", "Someone Else")], str(t))
    check("mp3 without a Xing header still gets a sane length", all(2800 < x["ms"] < 3300 for x in t), str(t))
    check("genres", [g["name"] for g in call("genres")[1]["genres"]] == ["Ambient", "Pop"])
    check("tracks by genre", len(call("tracks", {"genre": "Pop"})[1]["tracks"]) == 2)
    check("tracks under a folder, recursive", len(call("tracks", {"folder": "Music/Artist One"})[1]["tracks"]) == 2 and len(call("tracks", {"folder": "Music"})[1]["tracks"]) == 6)
    check("search ignores accents and case", [x["title"] for x in call("search", {"q": "edith CAFE"})[1]["tracks"]] == ["Café"])
    check("search finds an artist by unaccented name", [a["name"] for a in call("search", {"q": "edith"})[1]["artists"]] == ["Édith"])
    r = call("search", {"q": "second album"})[1]
    check("search: every word must match somewhere", [x["title"] for x in r["tracks"]] == ["Second"], str(r["tracks"]))
    check("search finds artists and albums", call("search", {"q": "compil"})[1]["albums"][0]["album"] == "Compilation")
    check("a % in a search is not a wildcard", call("search", {"q": "%"})[1]["tracks"] == [])

    print("offline filter")
    if shutil.which("node"):
        r = subprocess.run(["node", os.path.join(REPO, "tests", "offline-parity.js"), API], capture_output=True, text=True)
        print(r.stdout.rstrip())
        check("the offline filter answers like the server", r.returncode == 0, r.stdout[-600:] + r.stderr[-300:])
    else:
        print("  skip node not installed")

    print("signed links")
    first = call("ls", {"path": "Music/Artist One/Album A"})[1]["tracks"][0]
    tid = first["id"]
    check("a track carries its path and size (the app saves it under that path)", first["path"] == "Music/Artist One/Album A/01 - First.flac" and first["size"] > 0, str(first))
    cu = call("cover_url", {"t": tid})[1]
    check("cover_url gives a signed link the app can use as an image address", cu["ok"] and "md5=" in cu["url"] and cu["expires_in"] >= 60, str(cu))
    check("cover_url for a track with no cover is 404", call("cover_url", {"t": 999999})[0] == 404)
    u = call("url", {"id": tid})[1]
    url = u["url"]
    check("url has a signature and an expiry", "md5=" in url and "expires=" in url and "/a/Music/Artist%20One/Album%20A/01%20-%20First.flac" in url, url)
    exp = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["expires"][0]
    want = base64.urlsafe_b64encode(hashlib.md5(f"{exp}/a/Music/Artist One/Album A/01 - First.flac testsecret".encode()).digest()).decode().rstrip("=")
    check("signature matches the gateway's recipe (decoded path, one space)", f"md5={want}" in url, url)
    req = urllib.request.Request(url, headers={"Range": "bytes=100-199"})
    with urllib.request.urlopen(req) as r:
        check("a Range request gets 206 and 100 bytes", r.status == 206 and len(r.read()) == 100)
    try:
        urllib.request.urlopen(url[:-1] + ("0" if url[-1] != "0" else "1")); bad = 200
    except urllib.error.HTTPError as e:
        bad = e.code
    check("a changed link is refused (403)", bad == 403, str(bad))
    ed = call("ls", {"path": "Music/Édith & Co's"})[1]["tracks"][0]["id"]
    with urllib.request.urlopen(call("url", {"id": ed})[1]["url"]) as r:
        check("a name with accents, &, ' and a dash plays", r.status == 200)
    req = urllib.request.Request(f"{API}?action=cover&t={tid}", headers={"Cookie": "scray_test_session=1"})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k): return None
    try:
        urllib.request.build_opener(NoRedirect).open(req)
        code, loc = 200, ""
    except urllib.error.HTTPError as e:
        code, loc = e.code, e.headers.get("Location", "")
    check("cover redirects to a signed link", code == 302 and "/a/Music/Artist%20One/Album%20A/cover.jpg?md5=" in loc, f"{code} {loc}")
    nocover = call("ls", {"path": "Music/Édith & Co's"})[1]["tracks"][0]["id"]
    try:
        urllib.request.build_opener(NoRedirect).open(urllib.request.Request(f"{API}?action=cover&t={nocover}", headers={"Cookie": "scray_test_session=1"})); c404 = 200
    except urllib.error.HTTPError as e:
        c404 = e.code
    check("a track with no folder art: cover is 404", c404 == 404, str(c404))
    check("unknown track: url is 404", call("url", {"id": 999999})[0] == 404)

    print("playlists")
    all_tracks = call("tracks", {"order": "path"})[1]["tracks"]
    ids = [t["id"] for t in all_tracks]
    byname = {t["title"]: t["id"] for t in all_tracks}
    pls0 = call("playlists")[1]["playlists"]
    check("only the built-in Liked to begin with", [(p["name"], p["liked"], p["tracks"]) for p in pls0] == [("Liked", True, 0)], str(pls0))
    lid = pls0[0]["id"]
    check("playlists need a session", call("playlists", cookie=False)[0] == 401 and call("playlist_create", cookie=False, body={"name": "x"})[0] == 401)
    check("the scanner key can't touch playlists", call("playlists", cookie=False, worker="test-worker-key")[0] == 401)
    check("a name is required", call("playlist_create", body={"name": "   "})[0] == 400)
    check("a very long name is refused", call("playlist_create", body={"name": "x" * 101})[0] == 400)
    st, j = call("playlist_create", body={"name": "  Évening   mix ", "track_ids": [byname["Tune"], byname["Café"], 999999]})
    pid = j["id"]
    check("create with tracks (an unknown id is skipped, the name is tidied)", st == 200 and j["added"] == 2 and j["name"] == "Évening mix", str(j))
    check("names are unique, ignoring case and accents", call("playlist_create", body={"name": "evening MIX"})[0] == 409)
    st, j = call("playlist_create", body={"name": "Second"})
    pid2 = j["id"]
    check("an empty playlist", st == 200 and j["added"] == 0)
    pls = call("playlists")[1]["playlists"]
    check("list has Liked first, then by name, with counts", [p["name"] for p in pls][0] == "Liked" and sorted(p["name"] for p in pls[1:]) == ["Second", "Évening mix"], str(pls))
    ev = [p for p in pls if p["id"] == pid][0]
    check("count, length, no missing", ev["tracks"] == 2 and ev["missing"] == 0 and 5500 < ev["ms"] < 6500, str(ev))
    j = call("playlist_add", body={"id": pid, "track_ids": [byname["Second"], byname["Tune"], 424242]})[1]
    check("add appends, duplicates allowed, unknown skipped", j["added"] == 2 and j["skipped"] == 1, str(j))
    j = call("playlist", {"id": pid})[1]
    titles = [t["title"] for t in j["tracks"]]
    check("tracks come back in order, with entry ids", titles == ["Tune", "Café", "Second", "Tune"] and len({t["entry"] for t in j["tracks"]}) == 4, str(titles))
    check("track facts are the same shape as everywhere else", j["tracks"][1]["albumArtist"] and "ms" in j["tracks"][1] and j["playlist"]["tracks"] == 4, str(j["tracks"][1]))
    e = [t["entry"] for t in j["tracks"]]
    call("playlist_move", body={"id": pid, "entry": e[3], "before": e[0]})
    check("move before another", [t["title"] for t in call("playlist", {"id": pid})[1]["tracks"]] == ["Tune", "Tune", "Café", "Second"])
    call("playlist_move", body={"id": pid, "entry": e[3]})   # no 'before' = to the end
    j = call("playlist", {"id": pid})[1]
    check("move to the end", [t["entry"] for t in j["tracks"]] == [e[0], e[1], e[2], e[3]], str([t["entry"] for t in j["tracks"]]))
    check("moving something that isn't there is 404", call("playlist_move", body={"id": pid, "entry": 99999})[0] == 404 and call("playlist_move", body={"id": pid2, "entry": e[0]})[0] == 404)
    j = call("playlist_remove", body={"id": pid, "entries": [e[0], e[0], 777777]})[1]
    check("remove by entry (the other copy of the track stays)", j["removed"] == 1 and [t["title"] for t in call("playlist", {"id": pid})[1]["tracks"]] == ["Café", "Second", "Tune"])
    D = sqlite3.connect(DB)
    D.execute("UPDATE tracks SET deleted = 1 WHERE id = ?", (byname["Tune"],)); D.commit()
    pl = call("playlist", {"id": pid})[1]
    check("a track that left the library drops out of the playlist but is counted", pl["playlist"]["missing"] == 1 and [t["title"] for t in pl["tracks"]] == ["Café", "Second"], str(pl["playlist"]))
    check("the list shows the same count", [p for p in call("playlists")[1]["playlists"] if p["id"] == pid][0]["missing"] == 1)
    j = call("playlist_remove", body={"id": pid, "missing": True})[1]
    check("missing ones can be cleared in one go", j["removed"] == 1 and call("playlist", {"id": pid})[1]["playlist"]["missing"] == 0)
    D.execute("UPDATE tracks SET deleted = 0 WHERE id = ?", (byname["Tune"],)); D.commit(); D.close()
    check("rename", call("playlist_rename", body={"id": pid, "name": "Late"})[0] == 200 and call("playlist", {"id": pid})[1]["playlist"]["name"] == "Late")
    check("rename to a taken name is refused", call("playlist_rename", body={"id": pid, "name": "second"})[0] == 409)
    check("renaming to its own name (different case) is fine", call("playlist_rename", body={"id": pid2, "name": "SECOND"})[0] == 200)
    check("unknown playlist is 404", call("playlist", {"id": 9999})[0] == 404 and call("playlist_delete", body={"id": 9999})[0] == 404)
    call("playlist_add", body={"id": pid2, "track_ids": ids})
    call("playlist_delete", body={"id": pid2})
    check("delete removes it and its items", [p["id"] for p in call("playlists")[1]["playlists"]] == [lid, pid]
          and sqlite3.connect(DB).execute("SELECT COUNT(*) FROM playlist_items WHERE playlist_id = ?", (pid2,)).fetchone()[0] == 0)

    print("liked")
    check("nothing liked yet", call("liked")[1]["ids"] == [] and call("liked")[1]["id"] == lid)
    check("like needs POST", call("like", {"track_ids[]": "1"})[0] == 405)
    st, j = call("like", body={"track_ids": [byname["First"], byname["Second"], byname["First"], 424242], "on": True})
    check("liking adds each live track once", st == 200 and j["changed"] == 2 and sorted(j["ids"]) == sorted([byname["First"], byname["Second"]]), str(j))
    j = call("like", body={"track_ids": [byname["Tune"]], "on": True})[1]
    check("the newest like is first", j["ids"][0] == byname["Tune"] and len(j["ids"]) == 3, str(j))
    check("liking again changes nothing", call("like", body={"track_ids": [byname["Tune"]]})[1]["changed"] == 0)
    check("adding to Liked as a playlist doesn't double up", call("playlist_add", body={"id": lid, "track_ids": [byname["Tune"], byname["Other"]]})[1]["added"] == 1)
    j = call("like", body={"track_ids": [byname["Second"], byname["Other"]], "on": False})[1]
    check("unliking takes them out", j["changed"] == 2 and sorted(j["ids"]) == sorted([byname["Tune"], byname["First"]]), str(j))
    j = call("playlist", {"id": lid})[1]
    check("Liked opens like any playlist", j["playlist"]["liked"] is True and [t["id"] for t in j["tracks"]] == [byname["Tune"], byname["First"]], str(j)[:300])
    check("Liked can't be renamed", call("playlist_rename", body={"id": lid, "name": "Faves"})[0] == 400)
    check("Liked can't be deleted", call("playlist_delete", body={"id": lid})[0] == 400)
    check("no second playlist called Liked", call("playlist_create", body={"name": "liked"})[0] == 409)
    check("liking needs a session", call("like", cookie=False, body={"track_ids": [1]})[0] == 401)

    print("search finds folders")
    f = call("search", {"q": "artist one"})[1]["folders"]
    check("a matching folder, not its sub-folders", [x["path"] for x in f] == ["Music/Artist One"] and f[0]["tracks"] == 2, str(f))
    f = call("search", {"q": "artist album"})[1]["folders"]
    check("words can match across the path", [x["path"] for x in f] == ["Music/Artist One/Album A"], str(f))

    print("editing")
    sec = byname["Second"]
    st, j = call("track_info", {"id": sec})
    check("track_info has the file's tags", st == 200 and j["file"]["title"] == "Second" and j["file"]["album_artist"] == "" and j["edits"] == {}, str(j)[:300])
    check("edit needs POST", call("edit", {"id": sec})[0] == 405)
    check("an unknown field is refused", call("edit", body={"items": [{"id": sec, "set": {"path": "x"}}]})[0] == 400)
    check("a bad number is refused", call("edit", body={"items": [{"id": sec, "set": {"year": "nineteen"}}]})[0] == 400)
    st, j = call("edit", body={"items": [{"id": sec, "set": {"title": "  Second   Coming ", "year": 2001, "genre": "Ambient"}}]})
    t = j["tracks"][0] if st == 200 else {}
    check("an edit shows at once (spaces tidied)", st == 200 and t["title"] == "Second Coming" and t["year"] == 2001 and t["edited"] is True, str(j)[:300])
    edits = call("track_info", {"id": sec})[1]["edits"]
    check("...and only what differs from the file is kept", set(edits) == {"title", "year"} and edits["title"]["source"] == "manual", str(edits))
    check("search finds the new title", [x["title"] for x in call("tracks", {"q": "coming"})[1]["tracks"]] == ["Second Coming"])
    call("edit", body={"items": [{"id": byname["Tune"], "set": {"album_artist": "Compilers", "album": "Compiled"}},
                                 {"id": byname["Other"], "set": {"album_artist": "Compilers", "album": "Compiled"}}]})
    check("album artist and album edits regroup the albums", any(a["artist"] == "Compilers" and a["album"] == "Compiled" and a["tracks"] == 2 for a in call("albums")[1]["albums"])
          and not any(a["album"] == "Compilation" for a in call("albums")[1]["albums"]))
    # a rescan that re-reads the file keeps the edit on top of the new tags
    ff(os.path.join(BOX, "Music", "Artist One", "Album A", "02 - Second.flac"), dict(title="Second", artist="Artist One", album="Album A", track="2/2", date="1999", genre="Drone"), "flac")
    code, out = scan()
    st, j = call("track_info", {"id": sec})
    check("a rescan updates the file's tags but keeps the edits", j["file"]["genre"] == "Drone" and j["track"]["genre"] == "Drone" and j["track"]["title"] == "Second Coming", str(j)[:400])
    st, j = call("edit", body={"items": [{"id": sec, "set": {"year": None}}]})
    check("null puts one field back to the file's", j["tracks"][0]["year"] == 1999 and j["tracks"][0]["title"] == "Second Coming")
    st, j = call("edit_reset", body={"track_ids": [sec, byname["Tune"], byname["Other"]]})
    check("reset puts everything back", st == 200 and j["tracks"][0]["title"] == "Second" and j["tracks"][0]["edited"] is False
          and any(a["album"] == "Compilation" for a in call("albums")[1]["albums"]), str(j)[:300])
    check("tracks_by_id answers in the order asked, skipping unknown ids", [t["id"] for t in call("tracks_by_id", body={"ids": [sec, 424242, byname["First"]]})[1]["tracks"]] == [sec, byname["First"]])

    print("covers you choose")
    import base64 as b64m
    jpg = open(os.path.join(BOX, "Music", "Artist One", "Album A", "cover.jpg"), "rb").read()
    check("an upload that isn't a picture is refused", call("cover_upload", body={"track_ids": [byname["Tune"]], "data": b64m.b64encode(b"hello").decode()})[0] == 400)
    st, j = call("cover_upload", body={"track_ids": [byname["Tune"], byname["Other"]], "data": "data:image/jpeg;base64," + b64m.b64encode(jpg).decode()})
    check("an uploaded cover", st == 200 and all(t["cover"] and len(t["coverv"]) == 12 for t in j["tracks"]), str(j)[:300])
    st, j = call("cover_url", {"t": byname["Tune"]})
    check("cover_url points at the signed art link", st == 200 and "action=art" in j["url"], str(j))
    with urllib.request.urlopen(j["url"]) as r:
        got = r.read()
        check("the art link serves it, no login needed", got == jpg and r.headers["Content-Type"] == "image/jpeg")
    bad = j["url"].replace("&s=", "&s=0")
    try:
        urllib.request.urlopen(bad); forged = 200
    except urllib.error.HTTPError as e:
        forged = e.code
    check("a forged art link is refused", forged == 403)
    old = urllib.parse.urlparse(j["url"]); oq = urllib.parse.parse_qs(old.query)
    try:
        urllib.request.urlopen(f"{API}?action=art&f={oq['f'][0]}&e=1&s={oq['s'][0]}"); stale = 200
    except urllib.error.HTTPError as e:
        stale = e.code
    check("an expired art link is refused", stale == 403)
    check("the album's art is the new cover", any(a["album"] == "Compilation" and a["art"] in (byname["Tune"], byname["Other"]) for a in call("albums")[1]["albums"]))
    j = call("edit_reset", body={"track_ids": [byname["Tune"], byname["Other"]], "fields": ["cover"]})[1]
    check("resetting the cover goes back to none (that folder has no art)", all(not t["cover"] and t["coverv"] == "" for t in j["tracks"]), str(j)[:200])

    print("musicbrainz")
    hits = lambda: json.load(urllib.request.urlopen(f"http://127.0.0.1:{MB_PORT}/__hits"))["hits"]
    h0 = hits()
    st, j = call("mb_search", {"artist": "Artist One", "album": "Album A"})
    check("search finds releases", st == 200 and [r["id"] for r in j["releases"]][:1] == ["11111111-2222-3333-4444-555555555555"] and j["releases"][0]["format"] == "CD"
          and 'release:"Album A" AND artist:"Artist One"' == j["query"], str(j)[:400])
    call("mb_search", {"artist": "Artist One", "album": "Album A"})
    check("the same search again comes from the cache", hits() == h0 + 1)
    st, j = call("mb_release", {"id": "11111111-2222-3333-4444-555555555555"})
    r = j.get("release", {})
    check("a release with its tracks, credits, year and genres", st == 200 and r["year"] == 1999 and r["firstYear"] == 1998 and r["cover"] is True
          and [t["title"] for t in r["media"][0]["tracks"]] == ["First Light", "Second Wind"] and r["media"][0]["tracks"][1]["artist"] == "Artist One feat. Guest"
          and r["genres"][:2] == ["electronic", "ambient"], str(j)[:500])
    check("an unknown release is 404", call("mb_release", {"id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"})[0] == 404)
    check("a bad release id is refused before asking", call("mb_release", {"id": "x"})[0] == 400)
    st, j = call("edit", body={"source": "musicbrainz", "items": [{"id": sec, "set": {"title": "Second Wind", "mb_release": r["id"], "mb_recording": "rec-2"}}]})
    i = call("track_info", {"id": sec})[1]
    check("a MusicBrainz edit is marked as such, with its ids", i["edits"]["title"]["source"] == "musicbrainz" and i["mb"] == {"release": r["id"], "recording": "rec-2"}, str(i)[:300])
    st, j = call("cover_mb", body={"track_ids": [byname["First"], sec], "release": r["id"]})
    check("the cover from the Cover Art Archive (after its redirect)", st == 200 and all(t["coverv"] not in ("", "f") for t in j["tracks"]), str(j)[:300])
    check("a release with no cover says so", call("cover_mb", body={"track_ids": [sec], "release": "00000000-0000-0000-0000-000000000000"})[0] == 404)
    call("edit_reset", body={"track_ids": [sec, byname["First"]]})
    check("after reset the folder art is back", call("tracks_by_id", body={"ids": [sec]})[1]["tracks"][0]["coverv"] == "f")

    print("files that go away")
    os.remove(os.path.join(BOX, "Music", "Singles", "loose track.mp3"))
    code, out = scan()
    check("a complete rescan removes what's gone", code == 0 and call("stats")[1]["tracks"] == 5, out)
    code, out = scan({"SCRAY_SCAN_ROOT": "Music/Artist One"})
    check("a partial scan removes nothing", call("stats")[1]["tracks"] == 5 and code == 0, out)
    shutil.rmtree(os.path.join(BOX, "Music", "Various"))
    shutil.rmtree(os.path.join(BOX, "Music", "Édith & Co's"))
    shutil.rmtree(os.path.join(BOX, "Music", "Artist One"))
    # Small libraries are exempt from the "more than half" guard, so test that rule directly:
    st, r = call("audio_worker_finish", cookie=False, worker="test-worker-key", body={"scan_id": 1, "files_seen": 0, "complete": True})
    check("a walk that saw nothing prunes nothing", r.get("pruned") == 0 and r.get("skipped_prune"), str(r))

    print("changed files are re-read")
    ff(os.path.join(BOX, "Music", "Artist One", "Album A", "01 - First.flac"), dict(title="Renamed", artist="Artist One", album="Album A", track="1/1"), "flac")
    code, out = scan()
    r = call("tracks", {"folder": "Music/Artist One"})[1]["tracks"]
    check("a changed file gets new tags", [x["title"] for x in r] == ["Renamed"], str(r))

    print("scan button and live progress")
    W = dict(cookie=False, worker="test-worker-key")
    scan()   # a full scan, so we start from a known library
    st = call("scan_status")[1]
    last = st["scan"]
    N = last["files_seen"]
    check("progress is recorded by a normal scan", N >= 1 and last["finished_at"] and last["folders"] > 0 and last["tagged"] is not None and last["phase"] == "done", str(last))
    check("idle, with an expected size from the last complete scan", st["state"] == "idle" and st["expected"] == N and st["tracks"] == N, str(st))
    check("no scanner has checked in yet", st["worker_online"] is False and st["worker_age"] is None, str(st))
    check("scan_request is POST only", call("scan_request")[0] == 405)
    check("the scanner key can't press the button", call("scan_request", body={}, **W)[0] == 401)
    check("no session, no button", call("scan_request", cookie=False, body={})[0] == 401)

    check("pressing the button leaves a request", call("scan_request", body={})[1]["state"] == "requested")
    check("pressing it twice is still one request", call("scan_request", body={})[1]["state"] == "requested")
    j = call("audio_worker_poll", body={}, **W)[1]
    check("the gateway takes the request", j["requested"] is True)
    st = call("scan_status")[1]
    check("...which shows as starting, with the scanner online", st["state"] == "starting" and st["worker_online"] is True, str(st))
    check("the request is taken once", call("audio_worker_poll", body={}, **W)[1]["requested"] is False)

    sid = call("audio_worker_start", body={}, **W)[1]["scan_id"]
    st = call("scan_status")[1]
    check("a started scan is running", st["state"] == "running" and st["scan"]["id"] == sid, str(st))
    call("audio_worker_progress", body={"scan_id": sid, "phase": "scanning", "folders": 3, "files": 40, "tagged": 10, "errors": 1}, **W)
    sc = call("scan_status")[1]["scan"]
    check("progress shows live", (sc["folders"], sc["files_seen"], sc["tagged"], sc["errors"], sc["phase"]) == (3, 40, 10, 1, "scanning"), str(sc))
    check("pressing the button during a scan starts nothing", call("scan_request", body={})[1]["state"] == "running")

    DBH = sqlite3.connect(DB)
    DBH.execute("UPDATE scans SET heartbeat = '2000-01-01T00:00:00+00:00' WHERE id = ?", (sid,))
    DBH.commit()
    st = call("scan_status")[1]
    check("a scan that stopped reporting is flagged, not 'running' forever", st["state"] == "idle" and st["scan"]["stale"] is True, str(st))
    check("a stale scan can be replaced by a new request", call("scan_request", body={})[1]["state"] == "requested")
    call("audio_worker_poll", body={}, **W)

    call("audio_worker_finish", body={"scan_id": sid, "files_seen": 40, "complete": False, "error": "RuntimeError: boom"}, **W)
    st = call("scan_status")[1]
    check("a failed scan says why", st["scan"]["phase"] == "failed" and st["scan"]["note"] == "stopped: RuntimeError: boom" and st["scan"]["stale"] is False, str(st["scan"]))
    call("audio_worker_progress", body={"scan_id": sid, "files": 999}, **W)
    check("progress after the end changes nothing", call("scan_status")[1]["scan"]["files_seen"] == 40)
    DBH.close()
    scan()   # a new scan starting also clears the "starting" claim left above
    check("a scan starting clears the claim", call("scan_status")[1]["state"] == "idle")

    START = {"SCRAY_SCAN_START_CMD": f"{sys.executable} {SCANNER}"}
    code, out = scan(START, ["--poll"])
    check("--poll with no request does nothing, quietly", code == 0 and out.strip() == "", out)
    check("...but it counts as the scanner being online", call("scan_status")[1]["worker_online"] is True)
    before = call("scan_status")[1]["scan"]["id"]
    call("scan_request", body={})
    code, out = scan(START, ["--poll"])
    check("--poll starts a scan when the page asked for one", code == 0 and "asked for from the page" in out and f"done: {N} files" in out, out)
    st = call("scan_status")[1]
    check("...and the request is used up", st["state"] == "idle" and st["scan"]["id"] > before and st["scan"]["files_seen"] == N and st["scan"]["phase"] == "done", str(st))
    code, out = scan({"SCRAY_SCAN_START_CMD": "false"}, ["--poll"])
    check("--poll with nothing asked never runs the start command", code == 0, out)
    call("scan_request", body={})
    code, out = scan({"SCRAY_SCAN_START_CMD": "false"}, ["--poll"])
    check("a start command that fails makes --poll fail loudly", code != 0, out)


if __name__ == "__main__":
    try:
        main()
    finally:
        for p in procs:
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGTERM)
            except Exception:
                pass
    print()
    if fails:
        print(f"{len(fails)} FAILED: " + "; ".join(fails))
        sys.exit(1)
    print("all good")
