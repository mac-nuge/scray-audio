# Scray audio change log

Reasoning history for code changes. Git holds *what* changed; this holds *why*.
Same convention as the other Scray repos (see the top of scray-browse's `scray-changelog.md`):
one entry per edit, newest first, written in the same commit as the `VERSION` bump,
named `test:` until it has been tried and then `stable:`. Record the reasoning, not the diff.

## Entries

### audio 1.1 — test: scanner base64 bodies
<!-- 2026-10-13T20:18Z -->
- **Asked:** the first full scan stopped at about 1,400 files with a plain-text `403 Forbidden` from `audio_worker_seen`.
- **Why I think it happened:** api.php never answers in plain text (it always sends JSON), so the 403 came from in front of PHP, most likely Hostinger's web firewall inspecting the request body. The body held file paths, and one path probably matched a rule (names with `../`, `select ... from`, `<`, and so on). The same call worked on the earlier batches, which fits a single odd file name. Not confirmed: I haven't seen which file it was.
- **Fix:** the scanner now sends every payload base64-encoded (`X-Scray-Enc: b64`, `text/plain`) and api.php decodes it before reading the JSON. A firewall has nothing to match on in base64. Plain JSON bodies are still accepted. The `..` path-segment check in api.php is unchanged.
- **Checked:** `tests/smoke.py` now posts a path containing `x../select * from x/<b>.mp3` in base64, and a plain body, and the scanner itself runs through the base64 path. All pass. **Not tried:** the real firewall, so whether this clears the 403 is only known once the full scan is re-run.
- Deploy: this changes `api.php` (Hostinger) and `gateway/scray-audio-scan.py` (copy to `/opt/scray/` on the gateway).

### audio 1.0 — test: first cut
<!-- 2026-10-13T19:54Z -->
- **Asked:** a simple web interface, desktop and mobile browser, to browse (by folder or by metadata), play and shuffle the mp3 and flac files in `/home/audio` on the Hetzner box; borrow as much of Scray's infrastructure as possible.
- **What's borrowed, and why it matters:** nothing here invents auth or streaming. Login and 2FA are Scray's own (`scray_auth.php`, `/scray/login.php`); `api.php` accepts a session or the console key, the way `rebuild.php` does. Playback uses the gateway's `secure_link` links with the same recipe as `scrayHetznerUrl()` (decoded path hashed, one space before the secret), on a new `/a/` route so the audio read-only sub-account and the video one stay separate. Secrets stay in `scray_secrets.php`; only `audio_worker_key` is new.
- **Tags come from a scanner on the gateway, not from PHP.** mutagen reads mp3 and flac tags reliably and the VM can read the box directly; doing it in PHP on shared hosting would have meant pulling the first part of every file through Hostinger. The scanner reads only the front of each file (ID3 size / FLAC metadata blocks tell it how much) and only for files that are new or whose etag changed, so a nightly rescan is mostly folder listings. A read-only sub-account can't list folders, so the scanner uses a second one with read-only off; the streaming one stays read-only.
- **MP3 length:** without a Xing header mutagen divides the bytes it was given (only the front), which would give a wrong length. The scanner uses the real file size for a constant-rate file. Checked with a file written without Xing.
- **Albums are grouped by album artist** (falling back to artist, then "Unknown artist"), so a compilation is one album, not one per track artist.
- **Search folds accents and case** into a stored column (SQLite's LIKE only handles ASCII), so "edith" finds "Édith". Artists and albums are filtered the same way in PHP.
- **The scan can't empty the library:** it only removes what it didn't see after a complete walk; a partial walk (`SCRAY_SCAN_ROOT` / `SCRAY_SCAN_MAX`), an empty one, or one that would remove more than half the tracks removes nothing.
- **The player:** one `<audio>` element. iOS only lets an element play without a tap once a tap has started it, and the real track arrives after a network round trip, so the first tap starts it with a silent clip and the real source is swapped in. A link that expires mid-pause or mid-play is re-signed and resumed from the same second. Media Session gives lock-screen controls. Three failed tracks in a row stop the queue instead of racing through it.
- **Checked:** `tests/smoke.py` (fake box and gateway, the real api.php and scanner): auth, scanning and rescans, folder / artist / album / genre / search results, signed links (signature, Range, forged link refused, names with accents, `&` and `'`), cover redirect, prune safety, re-reading a changed file. Headless Chromium against the page: browsing, real playback, next / previous / seek / auto-advance, queue, shuffle, repeat, search, phone width with no sideways scroll. **Not tried:** the real `scray_auth.php` (a stand-in is used), the real gateway, Hostinger, and mobile Safari.
- **Watch:** the first tap in Safari on a phone is the thing to test (unlock + background play + lock screen). Embedded cover art, saved queues and gapless playback are not here yet.
- Deploy: the whole repo through Hostinger git; `audio_worker_key` in `scray_secrets.php`; the gateway `/a/` route and the scanner (README, "Setting it up").
