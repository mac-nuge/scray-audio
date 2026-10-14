#!/usr/bin/env python3
"""
The bulk MusicBrainz matcher (bulk-mb.php / api.php mb_bulk_*), end to end against tests/fake_mb.py:
the original vs the best match, ambiguous titles, nothing found, wrong lengths, a different track count,
collaborators and remixers, picking, skipping, undo, retry, the gateway driving it, and queueing writes.

  python3 tests/bulk_mb.py      (needs php, ffmpeg, python3-mutagen; runs in CI after smoke.py)
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import *


def lib():
    shutil.rmtree(BOX, ignore_errors=True)
    m = os.path.join(BOX, "Music")
    flac = lambda p, **t: ff(os.path.join(m, p), t, "flac")
    mp3 = lambda p, **t: ff(os.path.join(m, p), t, "libmp3lame", "-b:a", "128k")
    flac("Band X/Origins/01 - Dawn.flac", title="Dawn", artist="Band X", album="Origins", track="1/2")
    flac("Band X/Origins/02 - Dusk.flac", title="Dusk", artist="Band X", album="Origins", track="2/2")
    mp3("Compilations/Compilation Two/01 - One.mp3", title="One", artist="P", album="Compilation Two", track="1")
    mp3("Compilations/Compilation Two/02 - Two.mp3", title="Two", artist="Q", album="Compilation Two", track="2")
    mp3("Nobody/Nowhere/01 - Lost.mp3", title="Lost", artist="Nobody", album="Nowhere", track="1")
    mp3("Band Y/Long Ones/01 - Epic.mp3", title="Epic", artist="Band Y", album="Long Ones", track="1")
    mp3("Band Y/Long Ones/02 - Saga.mp3", title="Saga", artist="Band Y", album="Long Ones", track="2")
    mp3("DJ Test/Mix Tape/01.mp3", title="track 1", artist="DJ Test", album="Mix Tape", track="1")
    mp3("DJ Test/Mix Tape/02.mp3", title="track 2", artist="DJ Test", album="Mix Tape", track="2")
    mp3("Band Z/Short/01 - A.mp3", title="A", artist="Band Z", album="Short", track="1")
    mp3("Band Z/Short/02 - B.mp3", title="B", artist="Band Z", album="Short", track="2")
    mp3("Singles/loose.mp3")


def drive(limit=40):
    for _ in range(limit):
        st, j = call("mb_bulk_step", body={})
        assert st == 200, j
        if j.get("idle"):
            return j
    raise AssertionError("the run never finished")


def rows(state="all"):
    return {r["album"] if r["state"] != "matched" else r["folder"].rsplit("/", 1)[-1]: r for r in call("mb_bulk_list", {"state": state})[1]["rows"]}


def tr(title_or_id):
    ts = call("tracks", {"limit": 1000})[1]["tracks"]
    return next(t for t in ts if t["id"] == title_or_id or t["title"] == title_or_id)


def main():
    shutil.rmtree(WORK, ignore_errors=True); os.makedirs(WORK)
    lib()
    start([sys.executable, os.path.join(REPO, "tests", "fake_box.py"), BOX, str(BOX_PORT)])
    start([sys.executable, os.path.join(REPO, "tests", "fake_mb.py"), str(MB_PORT)])
    start(["php", "-S", f"127.0.0.1:{API_PORT}", "-t", REPO], {**PHP_ENV, "SCRAY_AUDIO_TEST_DB": DB})
    assert wait_up(f"{API}?action=ping") and wait_up(f"http://127.0.0.1:{MB_PORT}/__hits")
    code, out = scan()
    assert code == 0, out
    folder_of = lambda name: next(r for r in call("mb_bulk_list")[1]["rows"] if r["folder"].endswith(name))

    print("a run, the original of each")
    check("nothing to show before a run", call("mb_bulk_status")[1]["run"] is None)
    st, j = call("mb_bulk_start", body={"mode": "oldest"})
    check("start queues every album with a tag (not the loose track)", st == 200 and j["queued"] == 6, str(j))
    check("starting again while it runs is refused", call("mb_bulk_start", body={})[0] == 409)
    s = call("mb_bulk_status")[1]
    check("status: running, 6 to go, 1 track with no album tag", s["run"]["state"] == "running" and s["run_counts"]["pending"] == 6 and s["no_album"] == 1, str(s)[:300])
    check("pause stops the steps", call("mb_bulk_control", body={"do": "pause"})[1]["state"] == "paused" and call("mb_bulk_step", body={})[1].get("idle"))
    call("mb_bulk_control", body={"do": "resume"})
    drive()
    s = call("mb_bulk_status")[1]
    c = s["run_counts"]
    check("all settled: 2 matched, 3 to review, 1 not found; the run is done", c.get("matched") == 2 and c.get("review") == 3 and c.get("none") == 1 and s["run"]["state"] == "done", str(s)[:400])

    o = folder_of("Origins")
    check("Origins: the 1994 original, not the remaster with the better score", o["state"] == "matched" and o["release_id"].endswith("000000000001") and o["release_year"] == 1994, str(o))
    d = tr("Dawn")
    check("...its tracks: titles, album, year, genre", d["album"] == "Origins" and d["year"] == 1994 and d["genre"] == "Post-Rock", str(d))
    check("...and a cover from its release group (the release had none)", d["coverv"] not in ("", "f") and o["has_cover"] == 1, str(d))
    m1, m2 = tr("Track One"), tr("Track Two (Remixer X Remix)")
    check("collaborators come in with the artist credit", m1["artist"] == "DJ Test feat. Guest" and m2["artist"] == "DJ Test x Other", f"{m1['artist']} / {m2['artist']}")
    check("a remixer the title doesn't name is added to it", m2["title"] == "Track Two (Remixer X Remix)")
    check("genre in title case", m1["genre"] == "Hip Hop")
    r = {x["album"]: x for x in call("mb_bulk_list", {"state": "review"})[1]["rows"]}
    check("same title, different artists: set aside, with both to choose from", "different artists" in r["Compilation Two"]["reason"] and len(r["Compilation Two"]["candidates"]) == 2, str(r.get("Compilation Two")))
    check("lengths far off: set aside", "lengths" in r["Long Ones"]["reason"], r["Long Ones"]["reason"])
    check("only a different track count: set aside, saying so", "3 tracks" in r["Short"]["reason"] and "you have 2" in r["Short"]["reason"], r["Short"]["reason"])
    n = call("mb_bulk_list", {"state": "none"})[1]["rows"]
    check("nothing found: listed as such", [x["album"] for x in n] == ["Nowhere"] and "nothing found" in n[0]["reason"], str(n))
    check("the list filters by text", [x["album"] for x in call("mb_bulk_list", {"q": "band y"})[1]["rows"]] == ["Long Ones"])

    print("reviewing")
    cid = r["Compilation Two"]["id"]
    st, j = call("mb_bulk_pick", body={"id": cid, "release": "bbbbbbbb-0000-0000-0000-000000000010"})
    one = tr("One")
    check("picking a release applies it", st == 200 and one["albumArtist"] == "Artist P" and tr("Two")["album"] == "Compilation Two", str(j))
    check("...and marks it picked", next(x for x in call("mb_bulk_list")[1]["rows"] if x["id"] == cid)["reason"] == "picked by you")
    check("skip", call("mb_bulk_skip", body={"id": r["Long Ones"]["id"]})[1]["state"] == "skipped")
    call("edit", body={"items": [{"id": m1["id"], "set": {"genre": "Mine"}}]})
    mix = folder_of("Mix Tape")
    call("mb_bulk_undo", body={"id": mix["id"]})
    m1b = tr(m1["id"])
    check("undo takes off what MusicBrainz put on, and keeps your own edit", m1b["title"] == "track 1" and m1b["artist"] == "DJ Test" and m1b["genre"] == "Mine" and m1b["coverv"] == "", str(m1b))

    print("another run: retry, the best match, the gateway, writing")
    st, j = call("mb_bulk_start", body={})
    check("a plain run has nothing new to do", j["queued"] == 0 and call("mb_bulk_status")[1]["run"]["state"] == "done", str(j))
    call("mb_bulk_undo", body={"id": o["id"]})
    call("mb_bulk_retry", body={"id": o["id"]})
    st, j = call("mb_bulk_start", body={"mode": "best", "retry": True, "write": True})
    check("retry brings back the ones set aside (not the skipped one), plus Origins", j["queued"] == 3, str(j))
    code, out = scan({"SCRAY_MB_BUDGET": "20"}, ["--poll"])
    s = call("mb_bulk_status")[1]
    check("the gateway drives the run from its poll", code == 0 and s["run"]["last_step_by"] == "gateway" and s["run"]["state"] == "done", out + str(s)[:300])
    o2 = folder_of("Origins")
    d2 = tr(tr("Dawn (Remastered)")["id"])
    check("best match: the remaster (best score), its year, its own cover", o2["release_id"].endswith("000000000002") and d2["year"] == 2004 and o2["has_cover"] == 1, str(o2))
    st, j = call("push_status", {"ids": str(d2["id"])})
    check("with “write” ticked, matched albums are queued to be written into the files", j["tracks"][0]["job"] and j["tracks"][0]["job"]["state"] == "queued", str(j)[:300])
    st, j = call("mb_bulk_control", body={"do": "stop"})
    check("stop", j["state"] == "stopped")


if __name__ == "__main__":
    try:
        main()
    finally:
        for p in procs:
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGTERM)
            except Exception:
                pass
    if fails:
        print(f"\n{len(fails)} FAILED: " + "; ".join(fails))
        sys.exit(1)
    print("\nall good")
