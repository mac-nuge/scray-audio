#!/usr/bin/env python3
"""
A stand-in for MusicBrainz (/ws/2) and the Cover Art Archive, for tests.

  python3 fake_mb.py PORT

  /ws/2/release?query=...&fmt=json      one or two releases, whatever is asked
  /ws/2/release/<id>?inc=...&fmt=json   a release with its tracks
  /release/<id>/front-1200, front-250   a small JPEG (redirected once, like the real one)
  /__hits                               how many /ws/2 requests arrived (to check the cache)
"""
import json, sys, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
REL = "11111111-2222-3333-4444-555555555555"
OTHER = "99999999-8888-7777-6666-555555555555"
NOCOVER = "00000000-0000-0000-0000-000000000000"
# a tiny valid JPEG (1x1)
JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720"
    "222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405"
    "060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282"
    "090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495"
    "969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008"
    "010100003f00fbd3ffd9")
hits = 0


# ---- a little catalogue for the bulk matcher (tests/bulk_mb.py) ------------------------------
def U(n):
    return f"bbbbbbbb-0000-0000-0000-{n:012d}"


def trk(no, title, ms, credit=None, remixer=None, rec=None):
    t = {"position": no, "title": title, "length": ms, "artist-credit": credit or [], "recording": {"id": rec or f"rec-{title}"}}
    if remixer:
        t["recording"]["relations"] = [{"type": "remixer", "direction": "backward", "artist": {"name": remixer}}]
    return t


def rel(n, title, artist, date, rg, rg_first, tracks, score=100, cover=False, status="Official", genres=None):
    credit = [{"name": a, "joinphrase": j} for a, j in artist] if isinstance(artist, list) else [{"name": artist}]
    return {"id": U(n), "title": title, "date": date, "status": status, "country": "GB", "score": score, "cover": cover,
            "artist-credit": credit, "track-count": len(tracks),
            "release-group": {"id": rg, "primary-type": "Album", "first-release-date": rg_first, "genres": genres or []},
            "media": [{"position": 1, "format": "CD", "tracks": tracks}]}


O_TRACKS = [trk(1, "Dawn", 3000, [{"name": "Band X"}]), trk(2, "Dusk", 3000, [{"name": "Band X"}])]
CATALOG = {
    # the original (1994, no cover of its own; its release group has one) and a remaster (2004, best score, a cover)
    "origins": [rel(1, "Origins", "Band X", "1994-02-01", "rg-origins", "1994-02-01", O_TRACKS, score=88, genres=[{"name": "post-rock", "count": 4}]),
                rel(2, "Origins (2004 Remaster)", "Band X", "2004-06-01", "rg-origins", "1994-02-01",
                    [trk(1, "Dawn (Remastered)", 3000, [{"name": "Band X"}]), trk(2, "Dusk (Remastered)", 3000, [{"name": "Band X"}])], score=100, cover=True),
                rel(3, "Origins (Live)", "Band X", "1999", "rg-origins-live", "1999", O_TRACKS, score=80),
                rel(4, "Origins", "Band X", "2014", "rg-origins", "1994-02-01", O_TRACKS + [trk(3, "Bonus", 3000)], score=95)],
    # the same title by two different artists, and nothing of ours to tell them apart
    "compilation two": [rel(10, "Compilation Two", "Artist P", "2001", "rg-c2p", "2001", [trk(1, "One", 3000), trk(2, "Two", 3000)], score=100),
                        rel(11, "Compilation Two", "Artist Q", "2003", "rg-c2q", "2003", [trk(1, "Uno", 3000), trk(2, "Dos", 3000)], score=100)],
    # lengths far off: the wrong album with the right name
    "long ones": [rel(20, "Long Ones", "Band Y", "2010", "rg-long", "2010", [trk(1, "Epic", 300000), trk(2, "Saga", 400000)])],
    # collaborators and a remixer
    "mix tape": [rel(30, "Mix Tape", "DJ Test", "2018", "rg-mix", "2018",
                     [trk(1, "Track One", 3000, [{"name": "DJ Test", "joinphrase": " feat. "}, {"name": "Guest"}]),
                      trk(2, "Track Two", 3000, [{"name": "DJ Test", "joinphrase": " x "}, {"name": "Other"}], remixer="Remixer X")],
                     genres=[{"name": "hip hop", "count": 2}])],
    # only a 3-track version exists
    "short": [rel(40, "Short", "Band Z", "2012", "rg-short", "2012", [trk(1, "A", 3000), trk(2, "B", 3000), trk(3, "C", 3000)])],
}
BY_ID = {r["id"]: r for rs in CATALOG.values() for r in rs}
GROUP_COVER = {"rg-origins"}


def search(query):
    import re
    m = re.search(r'release:"((?:[^"\\]|\\.)*)"', query)
    if not m:
        return None
    title = m.group(1).replace('\\"', '"').lower()
    if title not in CATALOG:
        return None if title in ("album a", "compilation", "live", "mixtape", "x") else []
    out = []
    for r in CATALOG[title]:
        a = re.search(r'artist:"([^"]*)"', query)
        if a and a.group(1).lower() not in " ".join(c["name"] for c in r["artist-credit"]).lower():
            continue
        t = re.search(r"tracks:(\d+)", query)
        if t and int(t.group(1)) != r["track-count"]:
            continue
        s = {k: v for k, v in r.items() if k not in ("media", "cover")}
        s["media"] = [{"format": "CD", "track-count": r["track-count"]}]
        out.append(s)
    return out


def release(rid):
    if rid == REL:
        return {"id": REL, "title": "Album A (Remastered)", "date": "1999-05-01", "country": "GB", "status": "Official",
                "artist-credit": [{"name": "Artist One", "joinphrase": ""}],
                "release-group": {"primary-type": "Album", "first-release-date": "1998-11-02", "genres": [{"name": "ambient", "count": 3}]},
                "genres": [{"name": "electronic", "count": 5}],
                "cover-art-archive": {"front": True},
                "media": [{"position": 1, "format": "CD", "tracks": [
                    {"position": 1, "title": "First Light", "length": 3010, "artist-credit": [{"name": "Artist One"}], "recording": {"id": "rec-1"}},
                    {"position": 2, "title": "Second Wind", "length": 2990, "artist-credit": [{"name": "Artist One", "joinphrase": " feat. "}, {"name": "Guest"}], "recording": {"id": "rec-2"}},
                ]}]}
    if rid == NOCOVER:
        r = release(REL); r["id"] = NOCOVER; r["cover-art-archive"] = {"front": False}; return r
    return None


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        global hits
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        p = u.path
        if p == "/__hits":
            return self.send(200, {"hits": hits})
        if p.startswith("/ws/2/"):
            hits += 1
            if "ScrayAudio/" not in (self.headers.get("User-Agent") or ""):
                return self.send(403, {"error": "say who you are"})
            if p == "/ws/2/release":
                query = (q.get("query") or [""])[0]
                found = search(query)
                if found is not None:
                    return self.send(200, {"releases": found, "query": query})
                rels = [] if "nothing" in query else [
                    {"id": REL, "score": 100, "title": "Album A (Remastered)", "date": "1999-05-01", "country": "GB", "status": "Official", "track-count": 2,
                     "artist-credit": [{"name": "Artist One"}], "release-group": {"primary-type": "Album"}, "media": [{"format": "CD", "track-count": 2}]},
                    {"id": OTHER, "score": 70, "title": "Album A", "date": "2010", "country": "US", "track-count": 3, "disambiguation": "deluxe",
                     "artist-credit": [{"name": "Artist One"}], "release-group": {"primary-type": "Album"}, "media": [{"format": "Digital Media"}]},
                ]
                return self.send(200, {"releases": rels, "query": query})
            rid = p.rsplit("/", 1)[-1]
            if rid in BY_ID:
                r = dict(BY_ID[rid])
                r["cover-art-archive"] = {"front": r.pop("cover")}
                return self.send(200, r)
            r = release(rid)
            return self.send(200, r) if r else self.send(404, {"error": "Not Found"})
        if p.startswith("/release-group/"):
            if p.split("/")[2] in GROUP_COVER and p.endswith("front-1200"):
                return self.send(200, JPEG + b"rg", "image/jpeg")
            return self.send(404, b"no", "text/plain")
        if p.startswith("/release/"):
            rid = p.split("/")[2]
            if rid in BY_ID and BY_ID[rid]["cover"]:
                return self.send(200, JPEG + rid.encode(), "image/jpeg")
            if rid != REL:
                return self.send(404, b"no", "text/plain")
            if not p.endswith("/img"):
                self.send_response(307); self.send_header("Location", f"/release/{rid}/{p.rsplit('/', 1)[-1]}/img"); self.send_header("Content-Length", "0"); self.end_headers(); return
            return self.send(200, JPEG, "image/jpeg")
        self.send(404, b"?", "text/plain")


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
