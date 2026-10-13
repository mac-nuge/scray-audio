#!/usr/bin/env python3
"""
Scray audio :: the library scanner.

Runs on the gateway VM (like scray-migrate.py). Walks the Storage Box's
/home/audio over WebDAV with the scanning sub-account, reads each new or
changed file's tags with mutagen, and sends the result to the audio api.php.
It never writes to the box. It only ever reads the first few hundred KB of a
file (tags sit at the front of mp3 and flac), so a rescan of a big library is
mostly folder listings.

  1. start   - api.php hands back a scan id
  2. walk    - PROPFIND, one folder at a time
  3. seen    - each batch of files goes to api.php, which answers with the ones
               that are new or changed
  4. tags    - those are read (a few at a time) and sent back
  5. finish  - files not seen this time are marked gone, but only after a
               complete walk

Settings come from the environment (EnvironmentFile=/etc/scray/audio-scan.env):

  SCRAY_AUDIO_API         https://macnguyen.com/audio-staging/api.php
  SCRAY_AUDIO_WORKER_KEY  audio_worker_key from scray_secrets.php
  SCRAY_DAV_URL           https://u673373-sub4.your-storagebox.de
  SCRAY_DAV_USER          u673373-sub4
  SCRAY_DAV_PASS          the sub-account's password
  SCRAY_TAG_WORKERS       tag readers at once (default 4)
  SCRAY_SCAN_ROOT         only walk this folder, e.g. Music/part f (default: all).
                          A partial walk never marks anything as gone.
  SCRAY_SCAN_MAX          stop after this many files (testing). Also partial.

Needs python3-mutagen (apt install python3-mutagen).
"""
import base64
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

try:
    import mutagen  # noqa: F401  (the readers are imported where they are used)
except ImportError:
    sys.exit("mutagen is missing: apt install python3-mutagen")

AUDIO_EXTS = {"mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav"}
COVER_RE = re.compile(r"^(cover|folder|front|album|albumart|artwork)(?:[ _-]?\d+)?\.(jpe?g|png)$", re.I)
COVER_RANK = {"cover": 0, "folder": 1, "front": 2, "album": 3, "albumart": 4, "artwork": 5}
SKIP_DIR = re.compile(r"^(\.|@|#recycle$|\$RECYCLE\.BIN$|System Volume Information$)", re.I)
UA = "scray-audio-scan/1.0"

HEAD_START = 256 * 1024      # first read of a file
HEAD_MAX = 24 * 1024 * 1024  # never read more than this from the front of an mp3/flac
WHOLE_MAX = 60 * 1024 * 1024  # m4a/ogg/wav: read the lot, up to this

PROPFIND_BODY = (
    b'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
    b"<d:resourcetype/><d:getcontentlength/><d:getetag/><d:getlastmodified/>"
    b"</d:prop></d:propfind>"
)


def env(name, default=None, required=False):
    v = os.environ.get(name, default)
    if required and not v:
        sys.exit(f"{name} is not set")
    return v


API = env("SCRAY_AUDIO_API", required=True)
WORKER_KEY = env("SCRAY_AUDIO_WORKER_KEY", required=True)
DAV = env("SCRAY_DAV_URL", required=True).rstrip("/")
DAV_USER = env("SCRAY_DAV_USER", required=True)
DAV_PASS = env("SCRAY_DAV_PASS", required=True)
TAG_WORKERS = int(env("SCRAY_TAG_WORKERS", "4"))
ROOT = env("SCRAY_SCAN_ROOT", "").strip("/")
MAX_FILES = int(env("SCRAY_SCAN_MAX", "0") or 0)
DAV_AUTH = "Basic " + base64.b64encode(f"{DAV_USER}:{DAV_PASS}".encode()).decode()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def http(url, method="GET", headers=None, data=None, timeout=90, tries=4):
    last = None
    for i in range(tries):
        req = urllib.request.Request(url, data=data, method=method, headers={"User-Agent": UA, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            body = e.read()
            if e.code < 500 and e.code != 429:
                return e.code, body
            last = f"HTTP {e.code}"
        except Exception as e:  # network blip, timeout
            last = repr(e)
        time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"{method} {url}: {last}")


def api(action, payload=None):
    status, body = http(
        f"{API}?action={action}", "POST",
        {"X-Scray-Worker": WORKER_KEY, "Content-Type": "application/json"},
        json.dumps(payload or {}).encode(),
    )
    try:
        j = json.loads(body)
    except ValueError:
        raise RuntimeError(f"{action}: HTTP {status}, not JSON: {body[:200]!r}")
    if status != 200 or not j.get("ok"):
        raise RuntimeError(f"{action}: HTTP {status}: {j.get('error', j)}")
    return j


def dav_url(path):
    return DAV + "/" + urllib.parse.quote(path.strip("/"), safe="/") if path.strip("/") else DAV + "/"


# ---------------------------------------------------------------------------
# Walking
# ---------------------------------------------------------------------------

def propfind(folder):
    """Entries of one folder: [(name, is_dir, size, etag, mtime)]."""
    url = dav_url(folder) + ("/" if folder else "")
    status, body = http(url, "PROPFIND",
                        {"Authorization": DAV_AUTH, "Depth": "1", "Content-Type": "application/xml"},
                        PROPFIND_BODY)
    if status != 207:
        raise RuntimeError(f"PROPFIND {folder or '/'}: HTTP {status}")
    ns = {"d": "DAV:"}
    me = urllib.parse.unquote(urllib.parse.urlparse(url).path).rstrip("/")
    out = []
    for resp in ET.fromstring(body).findall("d:response", ns):
        href = resp.findtext("d:href", "", ns)
        path = urllib.parse.unquote(urllib.parse.urlparse(href).path)
        if path.rstrip("/") == me:
            continue
        name = path.rstrip("/").rsplit("/", 1)[-1]
        prop = resp.find("d:propstat/d:prop", ns)
        if prop is None or not name:
            continue
        is_dir = prop.find("d:resourcetype/d:collection", ns) is not None
        size = prop.findtext("d:getcontentlength", None, ns)
        out.append((name, is_dir, int(size) if size and size.isdigit() else None,
                    prop.findtext("d:getetag", None, ns), prop.findtext("d:getlastmodified", None, ns)))
    return out


def pick_cover(names):
    best = None
    for n in names:
        m = COVER_RE.match(n)
        if m:
            rank = (COVER_RANK[m.group(1).lower()], n.lower())
            if best is None or rank < best[0]:
                best = (rank, n)
    return best[1] if best else None


# ---------------------------------------------------------------------------
# Reading tags
# ---------------------------------------------------------------------------

def fetch_range(path, start, end):
    status, body = http(dav_url(path), "GET", {"Authorization": DAV_AUTH, "Range": f"bytes={start}-{end}"}, timeout=120)
    if status not in (200, 206):
        raise RuntimeError(f"GET HTTP {status}")
    return body[: end - start + 1] if status == 200 else body


def id3_size(buf):
    """Bytes taken by a leading ID3v2 tag (0 if none)."""
    if buf[:3] != b"ID3" or len(buf) < 10:
        return 0
    n = (buf[6] & 0x7F) << 21 | (buf[7] & 0x7F) << 14 | (buf[8] & 0x7F) << 7 | (buf[9] & 0x7F)
    return 10 + n + (10 if buf[5] & 0x10 else 0)


def wanted_len(buf, ext, size):
    """How many bytes from the front the tags need; <= len(buf) means we have enough."""
    if ext == "mp3":
        t = id3_size(buf)
        return t + 96 * 1024 if t else 96 * 1024
    if ext == "flac":
        if buf[:4] != b"fLaC":
            return 0
        pos = 4
        while True:
            if pos + 4 > len(buf):
                return pos + 4
            last = buf[pos] & 0x80
            pos += 4 + int.from_bytes(buf[pos + 1:pos + 4], "big")
            if last:
                return pos
    return size  # m4a, ogg, opus, wav, aac: all of it


def get_head(path, ext, size):
    if ext not in ("mp3", "flac") and size > WHOLE_MAX:
        raise RuntimeError(f"too big to tag ({size // 1048576} MB)")
    n = min(HEAD_START if ext in ("mp3", "flac") else size, size)
    while True:
        buf = fetch_range(path, 0, n - 1)
        want = min(wanted_len(buf, ext, size), size)
        if want <= len(buf) or len(buf) >= size:
            return buf
        if want > HEAD_MAX and ext in ("mp3", "flac"):
            raise RuntimeError("tag block larger than 24 MB")
        n = want


def first(tags, *names):
    for n in names:
        try:
            v = tags.get(n)
        except Exception:
            v = None
        if v:
            return [str(x).strip() for x in (v if isinstance(v, (list, tuple)) else [v]) if str(x).strip()]
    return []


def num(s):
    m = re.match(r"\s*(\d+)", s or "")
    return int(m.group(1)) if m else None


def year(s):
    m = re.search(r"(\d{4})", s or "")
    return int(m.group(1)) if m else None


def open_audio(buf, ext):
    f = io.BytesIO(buf)
    if ext == "mp3":
        from mutagen.mp3 import EasyMP3
        return EasyMP3(f)
    if ext == "flac":
        from mutagen.flac import FLAC
        return FLAC(f)
    if ext == "m4a":
        from mutagen.mp4 import MP4
        return MP4(f)
    if ext in ("ogg", "oga"):
        from mutagen.oggvorbis import OggVorbis
        return OggVorbis(f)
    if ext == "opus":
        from mutagen.oggopus import OggOpus
        return OggOpus(f)
    if ext == "wav":
        from mutagen.wave import WAVE
        return WAVE(f)
    if ext == "aac":
        from mutagen.aac import AAC
        return AAC(f)
    raise RuntimeError("unsupported type " + ext)


def read_tags(path, ext, size):
    """One file's tags as the api wants them. Never raises: a bad file is still a file."""
    out = {"path": path}
    try:
        buf = get_head(path, ext, size)
        audio = open_audio(buf, ext)
        tags = audio.tags or {}
        if ext == "m4a":
            def mp4(k):
                return [str(x).strip() for x in (tags.get(k) or []) if str(x).strip()]
            trkn, disk = (tags.get("trkn") or [(None, 0)])[0], (tags.get("disk") or [(None, 0)])[0]
            out.update(title="; ".join(mp4("\xa9nam")), artist="; ".join(mp4("\xa9ART")),
                       album_artist="; ".join(mp4("aART")), album="; ".join(mp4("\xa9alb")),
                       track_no=trkn[0], disc_no=disk[0], year=year((mp4("\xa9day") or [""])[0]),
                       genre=(mp4("\xa9gen") or [""])[0])
        else:
            out.update(
                title="; ".join(first(tags, "title")),
                artist="; ".join(first(tags, "artist")),
                album_artist="; ".join(first(tags, "albumartist", "album artist", "albumartistsort")),
                album="; ".join(first(tags, "album")),
                track_no=num((first(tags, "tracknumber", "track") or [""])[0]),
                disc_no=num((first(tags, "discnumber", "disc") or [""])[0]),
                year=year((first(tags, "date", "year", "originaldate") or [""])[0]),
                genre=(first(tags, "genre") or [""])[0],
            )
        info = audio.info
        length = float(getattr(info, "length", 0) or 0)
        bitrate = int(getattr(info, "bitrate", 0) or 0)
        if ext == "mp3":
            # Without a Xing header mutagen divides the bytes it was given, which
            # is only the front of the file. Use the real size for a constant rate.
            mode = getattr(info, "bitrate_mode", None)
            if bitrate and (mode is None or int(mode) == 0) and size:
                length = max(0, size - id3_size(buf)) * 8 / bitrate
            out["codec"] = "MP3"
        elif ext == "flac":
            bits, sr = getattr(info, "bits_per_sample", 0), getattr(info, "sample_rate", 0)
            out["codec"] = f"FLAC {bits}/{sr / 1000:g}" if bits and sr else "FLAC"
            bitrate = int(size * 8 / length) if length > 0 and size else 0
        else:
            out["codec"] = ext.upper()
        out.update(duration_ms=int(length * 1000) if length > 0 else None, bitrate=bitrate or None,
                   sample_rate=getattr(info, "sample_rate", None), channels=getattr(info, "channels", None))
    except Exception as e:  # noqa: BLE001 - report it and move on
        out["error"] = f"{type(e).__name__}: {e}"[:300]
    return out


# ---------------------------------------------------------------------------
# The scan
# ---------------------------------------------------------------------------

class Scan:
    def __init__(self):
        self.id = api("audio_worker_start")["scan_id"]
        self.pending = []      # file dicts waiting to be sent
        self.seen = 0
        self.tagged = 0
        self.errors = 0
        self.folders = 0
        self.complete = True
        self.pool = ThreadPoolExecutor(max_workers=TAG_WORKERS)

    def flush(self):
        if not self.pending:
            return
        batch, self.pending = self.pending, []
        res = api("audio_worker_seen", {"scan_id": self.id, "files": batch})
        self.seen += res["seen"]
        need = set(res["need"])
        todo = [f for f in batch if f["path"] in need]
        if todo:
            results = list(self.pool.map(lambda f: read_tags(f["path"], f["path"].rsplit(".", 1)[-1].lower(), f.get("size") or 0), todo))
            self.errors += sum(1 for r in results if r.get("error"))
            api("audio_worker_tags", {"tracks": results})
            self.tagged += len(results)
        log(f"folders {self.folders}  files {self.seen}  tagged {self.tagged}  tag errors {self.errors}")

    def walk(self):
        stack = [ROOT]
        while stack:
            folder = stack.pop()
            try:
                entries = propfind(folder)
            except Exception as e:  # noqa: BLE001
                log("cannot list", repr(folder), "-", e)
                self.complete = False
                continue
            self.folders += 1
            names = [e[0] for e in entries if not e[1]]
            cover = pick_cover(names)
            for name, is_dir, size, etag, mtime in sorted(entries, key=lambda e: e[0].lower()):
                if SKIP_DIR.match(name):
                    continue
                rel = f"{folder}/{name}" if folder else name
                if is_dir:
                    stack.append(rel)
                    continue
                if name.rsplit(".", 1)[-1].lower() not in AUDIO_EXTS or "." not in name:
                    continue
                self.pending.append({"path": rel, "size": size, "etag": etag, "mtime": mtime,
                                     "cover": f"{folder}/{cover}" if cover and folder else cover})
                if MAX_FILES and self.seen + len(self.pending) >= MAX_FILES:
                    self.complete = False
                    self.flush()
                    return
            if len(self.pending) >= 200:
                self.flush()
        self.flush()

    def finish(self):
        partial = bool(ROOT) or bool(MAX_FILES)
        res = api("audio_worker_finish", {"scan_id": self.id, "files_seen": self.seen,
                                          "complete": self.complete and not partial})
        return res


def main():
    log(f"scan starting: {DAV_USER} {'/' + ROOT if ROOT else '(whole box)'}")
    scan = Scan()
    try:
        scan.walk()
    finally:
        res = scan.finish()
    log(f"done: {scan.seen} files, {scan.tagged} tagged, {scan.errors} tag errors, {res['pruned']} marked gone"
        + (f" ({res['skipped_prune']})" if res.get("skipped_prune") else "")
        + ("" if scan.complete else "  [INCOMPLETE: some folders could not be listed]"))
    return 0 if scan.complete else 2


if __name__ == "__main__":
    sys.exit(main())
