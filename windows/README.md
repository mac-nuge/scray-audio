# Scray Audio for Windows

A portable Windows player with a bundled interface, taskbar playback controls and
offline downloads. Its HTML, CSS and JavaScript are generated from the shared player
at build time. The server is needed for sign-in, the online library and new downloads;
saved music, artwork, folder browsing and search work without it.

## Use the portable app

1. Extract the whole Windows ZIP into a writable folder, such as Documents.
2. Open `Scray-Audio.exe`, enter the production or staging library URL and sign in.
   This registers a Windows device using the same device-key flow as the iOS app;
   an old browser-wrapper login does not carry over.
3. Use **Save offline** in a track's menu, or the download menu for an album/folder.
4. The **Downloads** button shows progress, cancellation, retry, disk usage and sign-in.
5. Turn on **Offline** to browse only saved music. Saved files are preferred for
   playback even when online. **Remove from offline** deletes only the local copy.

The player opens without a connection. With saved tracks, a failed online request
falls back to the offline library. When offline, server-only features such as editing
server metadata, server playlists and scans still require a connection. Interrupted
downloads are not counted as saved; use Save offline again after restarting. Downloads
run while the app is open and stop when it closes.

Right-click the running taskbar icon and choose **Pin to taskbar**. Hover over it for
**Previous / Play-Pause / Next** while running. Minimise to keep playing; closing the
window quits. Media controls are disabled until a track is loaded.

## Portable data and updates

Back and Forward arrows in the header revisit folders, artists, albums and other
views. Playback uses the shared gapless scheduler: **Gapless ready** means the next
decoded track is scheduled without an added gap. Large files, unsupported decoders,
slow downloads or servers without CORS access retain streaming playback. See the
repository README for limits. Music is not crossfaded or silence-trimmed.

- `data/`: preferences, sign-in state and browser storage.
- `Offline/<library-id>/manifest.json`: saved track metadata and original library paths.
- `Offline/<library-id>/files/`: audio and artwork, named by a hash of the original path
  plus its extension. This supports Windows-reserved names and library paths that
  differ only in case without collisions. Do not rename these files.

Both folders sit beside the executable. **Keep both when updating the app.** Treat
`data/` as private. Moving to another computer may require signing in again. Moving
the app also requires re-pinning its taskbar shortcut.

**App > Change library address** selects a different library. Each address has separate
downloads and browser storage; switching back restores its saved library. **App > Open
offline files folder** opens that library's storage. Changing an address does not delete
the previous library's downloads.

Website changes do not update this bundled interface. Rebuild the Windows app after
changing shared player files; there is no second hand-maintained copy of those files.
This personal build is unsigned and may show a Windows publisher warning.

## Development and packaging

With Node.js 24 or newer, from `windows/`:

```powershell
npm ci
npm test
npm run test:desktop
npm run test:offline
npm run test:gapless
npm start
npm run package
```

The output is `dist/Scray-Audio-win32-x64/`; zip the entire folder. Generated assets,
bundled web files, downloads, data and build outputs are ignored by Git. The **Build
Windows app** workflow produces a ZIP and runs when shared player files or Windows
sources change.

`app/scripts/make-web.js --windows` builds `windows/web/`. Running that script without
the flag still builds the iOS interface. Windows uses `app.js` for device authentication
and `offline.js` for local browsing and the download queue. Its sandboxed preload
exposes only a small offline-storage interface to the local player; remote pages get
no filesystem or Node API. Native handlers restrict access to the selected local main
frame. Downloads require HTTPS, are streamed to temporary files, and become available
only after completion. Local playback supports byte ranges for seeking.

## Validation

Unit tests cover persistence, seek ranges, path confinement, interrupted downloads,
cancellation, shared artwork and library separation. The offline Electron integration
test downloads generated test audio/artwork through a mock media source, blocks all
real internet requests, reloads the actual bundled interface, then verifies offline
search, real audio playback, seeking, taskbar-command pause and removal.

Before distributing, check live sign-in/2FA and downloads against the intended server,
then quit, disconnect and reopen to play saved tracks. Check taskbar hover controls,
pinning and media keys on an interactive Windows desktop. Live credentials and a second
Windows machine are not part of the automated tests.
