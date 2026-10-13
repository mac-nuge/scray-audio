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
| `offline.js`, `app.js` | saving tracks on the phone and the Offline filter; the iOS app's sign-in and setup. Both do nothing in a browser tab |
| `api.php` | the API: browse, search, signed links, and the scanner's `audio_worker_*` actions |
| `audio-config.php` | where secrets and the database live (no secrets in it) |
| `gateway/scray-audio-scan.py` | the scanner; `.service` + `.timer` run it nightly; `audio-scan.env.example` |
| `gateway/scray-audio-scan-poll.*` | a service + timer that checks every 30 s whether the page's **Scan now** button was pressed |
| `tests/smoke.py` | end-to-end test with a fake box; run by CI. Includes `tests/offline-parity.js` (the Offline filter must answer like the server) |
| `tests/ui_offline.py` | the Offline filter and saving, in a real browser with a pretend app behind it (needs Playwright; run by hand) |
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
the four `scray-audio-scan*.service` / `.timer` files in `/etc/systemd/system/`, and a filled-in copy of `audio-scan.env.example` at
`/etc/scray/audio-scan.env` (mode 600). The scanning sub-account must have read-only **off**
(a read-only account can't list folders). Then:

```bash
systemctl daemon-reload
systemctl start scray-audio-scan && journalctl -u scray-audio-scan -f   # the first scan
systemctl enable --now scray-audio-scan.timer                            # nightly after that
systemctl enable --now scray-audio-scan-poll.timer                       # lets the page's Scan button start one
```

Once the poll timer is on you don't need the command line: the **⟳** button in the page's header opens the
scan panel, **Scan library now** leaves a request, the gateway picks it up within 30 seconds, and the panel
shows folders, files and tags as they're read. The scanner reports progress to `api.php` about every 2 s.

Try `SCRAY_SCAN_MAX=200` first. A scan limited by `SCRAY_SCAN_ROOT` or `SCRAY_SCAN_MAX` never marks
anything as gone, and neither does one that saw nothing or would remove more than half the library.

## Using it

Keys: `Space` play/pause, `N` / `P` next/previous, `J` / `L` (or ←/→) back/forward 10 s, `S` shuffle,
`M` mute, `/` search. **+** on a row adds to the queue (Shift: play next). On a phone the lock screen
controls work (Media Session).

**Menu and playlists.** Right-click a track (or tap its **⋯**; also in the queue and on the now-playing strip) for: Play,
Play next, Add to queue, Go to album, Go to artist, More by (when the track artist isn't the album artist), Show in
folder, Add to playlist. The **Playlists** tab lists them; **＋ Playlist** on any album, folder, artist or search page adds all
of its tracks. Inside a playlist the menu also has Move up / Move down / Remove. Playlists live in the server's database
(`scray-data/audio.sqlite`), so they are the same on every device. A track is remembered by its place in the library; if a
file is moved to a new path it drops out of the playlist (the page says how many are hidden, with a button to clear them).

**Offline (the iOS app).** In the app, **Save offline** is in the track menu, and **⤓ Offline** next to Play / Shuffle saves or
removes a whole album, folder, artist or playlist (it asks first, with the size and the free space). Saved files go in
`<the folder you pick>/Offline/<the track's library path>` (covers in `Offline/.covers/`), the same layout Scray Native uses for
its downloads, so they are ordinary files you can see in Files. The **Offline** toggle in the header shows only what is saved:
folders, artists, albums, genres and search all work from the phone's own list, with no connection. A saved track always plays
from the phone. Without a connection, or when signed out, the page switches to Offline by itself.

**Phone keys.** The app signs in the way Scray's other apps do (password and authenticator code to Scray's `device_pair`) and
sends the key it gets as `X-Scray-Key`. `api.php` accepts those keys by looking them up in `scray-data/scray_devices.json`
(the same file, hashed, that Scray's twofactor.php manages), so signing a phone out there cuts it off here too. The API also
sends CORS headers, because the app's page is not on the site's origin.

Supported: mp3, flac, m4a, aac, ogg, opus, wav - whatever the browser can decode. Safari doesn't play
ogg/opus.

## Developing

```bash
python3 tests/smoke.py     # needs php, ffmpeg, python3-mutagen, node
python3 tests/ui_offline.py   # optional: needs `pip install playwright` and a Chromium
```

`tests/stub-data/` stands in for Scray's `scray_auth.php` / `scray_secrets.php`. `SCRAY_AUDIO_DATA_DIR`
points the app at it; on the server that variable is never set.

**This repo is public. Never commit a secret, a key, a `.env`, or a database** (`.gitignore` covers the
usual ones).

## Not done yet

Embedded cover art (folder `cover.jpg` is used), gapless playback, saving the queue across a reload,
play counts, other-device sync, playlists offline (they need the server; Offline mode shows only their saved tracks).
