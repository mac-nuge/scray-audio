# scray-audio

A small web player for the audio library on the Hetzner Storage Box (`/home/audio`):
browse by **folder** or by **metadata** (artist, album, genre), search, play, queue
and shuffle. Desktop and phone browsers.

It is the audio sibling of Scray's video side and borrows its plumbing instead of
building its own:

| Needs | Comes from |
|---|---|
| Login, 2FA, sessions | Scray's `scray_auth.php` + `/scray/login.php` (same login as the other Scray pages) |
| Secrets | the same `scray_secrets.php`, outside the web root |
| Streaming | the gateway VM's signed, expiring, Range-capable links - a second route, `/a/`, next to the video `/v/` |
| Storage | the same Storage Box, a read-only sub-account scoped to `/home/audio` |
| Hosting, deploy | Hostinger, git deploy of `staging` |

```
browser ──► index.php + api.php (Hostinger) ──► audio.sqlite (scray-data/, outside the web root)
   │                  ▲
   │                  │ audio_worker_*   (tags, from the nightly scan)
   │            scray-audio-scan.py (gateway VM; mutagen; reads the box over WebDAV)
   │
   └──► https://video.macnguyen.com/a/<path>?md5=…&expires=…  (nginx secure_link ► Storage Box)
```

The page never sees the box's credentials. `api.php` hands out a signed link per
track (valid an hour; the player asks for a fresh one if it expires mid-pause).

## What's in here

| File | |
|---|---|
| `index.php`, `audio.js`, `audio.css` | the page (no libraries) |
| `api.php` | the API: browse, search, signed links, and the scanner's `audio_worker_*` actions |
| `audio-config.php` | where secrets and the database live (no secrets in it) |
| `gateway/scray-audio-scan.py` | the scanner; `.service` + `.timer` run it nightly; `audio-scan.env.example` |
| `tests/smoke.py` | end-to-end test with a fake box; run by CI |
| `VERSION`, `scray-changelog.md` | version name and the reasoning log, as in the other Scray repos |

## Setting it up

**1. Secrets.** In `scray-data/scray_secrets.php` (the array Scray already uses) add one key.
The gateway settings are the video ones, reused:

```php
'audio_worker_key' => '…',   // openssl rand -hex 32 - the scanner's key
// already there: 'hetzner_base', 'hetzner_secret', 'hetzner_ttl'
```

**2. Gateway route.** Add a `location /a/` to the gateway's nginx, a copy of `/v/` pointing at the
audio read-only sub-account (base `/home/audio`) with its own `Authorization` map. The signing secret is
the same as video's.

**3. Deploy the page.** Hostinger → Git → this repo, branch `staging`, into its own folder
(for example `audio-staging/`). The database, `scray-data/audio.sqlite`, is created on first request.

**4. Scanner.** On the gateway: `apt install python3-mutagen`; put `scray-audio-scan.py` in `/opt/scray/`,
the `.service` and `.timer` in `/etc/systemd/system/`, and a filled-in copy of `audio-scan.env.example` at
`/etc/scray/audio-scan.env` (mode 600). The scanning sub-account must have read-only **off**
(a read-only account can't list folders). Then:

```bash
systemctl daemon-reload
systemctl start scray-audio-scan && journalctl -u scray-audio-scan -f   # the first scan
systemctl enable --now scray-audio-scan.timer                            # nightly after that
```

Try `SCRAY_SCAN_MAX=200` first. A scan limited by `SCRAY_SCAN_ROOT` or `SCRAY_SCAN_MAX` never marks
anything as gone, and neither does one that saw nothing or would remove more than half the library.

## Using it

Keys: `Space` play/pause, `N` / `P` next/previous, `J` / `L` (or ←/→) back/forward 10 s, `S` shuffle,
`M` mute, `/` search. **+** on a row adds to the queue (Shift: play next). On a phone the lock screen
controls work (Media Session).

Supported: mp3, flac, m4a, aac, ogg, opus, wav - whatever the browser can decode. Safari doesn't play
ogg/opus.

## Developing

```bash
python3 tests/smoke.py     # needs php, ffmpeg, python3-mutagen
```

`tests/stub-data/` stands in for Scray's `scray_auth.php` / `scray_secrets.php`. `SCRAY_AUDIO_DATA_DIR`
points the app at it; on the server that variable is never set.

**This repo is public. Never commit a secret, a key, a `.env`, or a database** (`.gitignore` covers the
usual ones).

## Not done yet

Embedded cover art (folder `cover.jpg` is used), gapless playback, saving the queue across a reload,
playlists, play counts, other-device sync.
