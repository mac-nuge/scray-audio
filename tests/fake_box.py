#!/usr/bin/env python3
"""
A stand-in for the Storage Box + gateway, for tests.

  python3 fake_box.py ROOT PORT

  - WebDAV (PROPFIND depth 0/1, ranged GET, PUT, MOVE, DELETE) with Basic auth u:p, like the box.
    FAKE_READONLY=1 refuses writes (403), like a read-only sub-account.
  - /a/<path>?md5=&expires=  with the gateway's secure_link check, like nginx.
"""
import base64, hashlib, os, sys, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2])
SECRET = os.environ.get("FAKE_SECRET", "testsecret")
AUTH = "Basic " + base64.b64encode(b"scan:pw").decode()


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, code, body=b"", headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def real(self, rel):
        p = os.path.abspath(os.path.join(ROOT, rel))
        return p if p == ROOT or p.startswith(ROOT + os.sep) else None

    def serve_file(self, p):
        size = os.path.getsize(p)
        rng = self.headers.get("Range")
        start, end, code = 0, size - 1, 200
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].partition("-")
            start = int(a) if a else 0
            end = min(int(b), size - 1) if b else size - 1
            code = 206
        with open(p, "rb") as f:
            f.seek(start)
            data = f.read(end - start + 1)
        h = {"Accept-Ranges": "bytes", "Content-Type": "application/octet-stream"}
        if code == 206:
            h["Content-Range"] = f"bytes {start}-{end}/{size}"
        self.send(code, data, h)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(u.path)
        if path.startswith("/a/"):                       # the gateway
            q = urllib.parse.parse_qs(u.query)
            exp, md5 = (q.get("expires") or [""])[0], (q.get("md5") or [""])[0]
            want = base64.urlsafe_b64encode(hashlib.md5(f"{exp}{path} {SECRET}".encode()).digest()).decode().rstrip("=")
            if not exp or md5 != want:
                return self.send(403)
            if int(exp) < time.time():
                return self.send(410)
            p = self.real(path[3:])
        else:                                            # the box over WebDAV
            if self.headers.get("Authorization") != AUTH:
                return self.send(401, b"", {"WWW-Authenticate": 'Basic realm="x"'})
            p = self.real(path.lstrip("/"))
        if not p or not os.path.isfile(p):
            return self.send(404)
        self.serve_file(p)

    def do_PROPFIND(self):
        if self.headers.get("Authorization") != AUTH:
            return self.send(401, b"", {"WWW-Authenticate": 'Basic realm="x"'})
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        p = self.real(path.strip("/"))
        if p and os.path.isfile(p):                      # Depth 0 on a file
            st = os.stat(p)
            body = ('<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>' + urllib.parse.quote(path, safe="/;")
                    + f'</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>{st.st_size}</D:getcontentlength>'
                    + f'<D:getetag>"{st.st_size:x}-{st.st_mtime_ns:x}"</D:getetag><D:getlastmodified>x</D:getlastmodified></D:prop>'
                    + '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>').encode()
            return self.send(207, body, {"Content-Type": "text/xml; charset=utf-8"})
        if not p or not os.path.isdir(p):
            return self.send(404)
        # like a real WebDAV server may, ";" comes back as it is (it is allowed in a path)
        def resp(href, p2):
            if os.path.isdir(p2):
                return f"<D:response><D:href>{urllib.parse.quote(href, safe="/;")}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
            st = os.stat(p2)
            return (f"<D:response><D:href>{urllib.parse.quote(href, safe="/;")}</D:href><D:propstat><D:prop><D:resourcetype/>"
                    f"<D:getcontentlength>{st.st_size}</D:getcontentlength><D:getetag>\"{st.st_size:x}-{st.st_mtime_ns:x}\"</D:getetag>"
                    f"<D:getlastmodified>x</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>")
        base = "/" + path.strip("/") + ("/" if path.strip("/") else "")
        out = [resp(base, p)]
        for name in sorted(os.listdir(p)):
            full = os.path.join(p, name)
            out.append(resp(base + name + ("/" if os.path.isdir(full) else ""), full))
        body = ('<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' + "".join(out) + "</D:multistatus>").encode()
        self.send(207, body, {"Content-Type": "text/xml; charset=utf-8"})


    # ---- writing (the "write to files" step)
    def writable(self):
        if self.headers.get("Authorization") != AUTH:
            self.send(401, b"", {"WWW-Authenticate": 'Basic realm="x"'}); return None
        if os.environ.get("FAKE_READONLY") == "1":
            self.send(403); return None
        p = self.real(urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).lstrip("/"))
        if not p:
            self.send(403); return None
        return p

    def do_PUT(self):
        p = self.writable()
        if not p:
            return
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n)
        if not os.path.isdir(os.path.dirname(p)):
            return self.send(409)
        new = not os.path.exists(p)
        with open(p, "wb") as f:
            f.write(data)
        self.send(201 if new else 204)

    def do_MOVE(self):
        p = self.writable()
        if not p:
            return
        dst = self.real(urllib.parse.unquote(urllib.parse.urlsplit(self.headers.get("Destination", "")).path).lstrip("/"))
        if not dst or not os.path.isfile(p):
            return self.send(404 if dst else 403)
        existed = os.path.exists(dst)
        if existed and self.headers.get("Overwrite", "T") == "F":
            return self.send(412)
        os.replace(p, dst)
        self.send(204 if existed else 201)

    def do_DELETE(self):
        p = self.writable()
        if not p:
            return
        if os.path.isfile(p):
            os.remove(p)
            return self.send(204)
        self.send(404)


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
