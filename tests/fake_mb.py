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
                rels = [] if "nothing" in query else [
                    {"id": REL, "score": 100, "title": "Album A (Remastered)", "date": "1999-05-01", "country": "GB", "status": "Official", "track-count": 2,
                     "artist-credit": [{"name": "Artist One"}], "release-group": {"primary-type": "Album"}, "media": [{"format": "CD", "track-count": 2}]},
                    {"id": OTHER, "score": 70, "title": "Album A", "date": "2010", "country": "US", "track-count": 3, "disambiguation": "deluxe",
                     "artist-credit": [{"name": "Artist One"}], "release-group": {"primary-type": "Album"}, "media": [{"format": "Digital Media"}]},
                ]
                return self.send(200, {"releases": rels, "query": query})
            r = release(p.rsplit("/", 1)[-1])
            return self.send(200, r) if r else self.send(404, {"error": "Not Found"})
        if p.startswith("/release/"):
            rid = p.split("/")[2]
            if rid != REL:
                return self.send(404, b"no", "text/plain")
            if not p.endswith("/img"):
                self.send_response(307); self.send_header("Location", f"/release/{rid}/{p.rsplit('/', 1)[-1]}/img"); self.send_header("Content-Length", "0"); self.end_headers(); return
            return self.send(200, JPEG, "image/jpeg")
        self.send(404, b"?", "text/plain")


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
