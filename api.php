<?php
declare(strict_types=1);

// A fatal error would otherwise reach the page as a bare HTTP 500 with no
// words. Turn the last error of a dying request into the same JSON fail()
// makes (the same trick as scray-browse's api.php).
register_shutdown_function(static function (): void {
    $e = error_get_last();
    if (!$e || !in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) return;
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json');
    }
    echo json_encode(['ok' => false, 'error' => 'fatal: ' . $e['message'] . ' in ' . basename((string)$e['file']) . ':' . $e['line']]);
});

require_once __DIR__ . '/audio-config.php';

// ============================================================
// RESPONSE HELPERS
// ============================================================

function jsonOut(array $a, int $code = 200): void {
    http_response_code($code);
    echo json_encode($a, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
function fail(int $code, string $msg): void {
    jsonOut(['ok' => false, 'error' => $msg], $code);
}

$action = (string)($_GET['action'] ?? '');

header('X-Robots-Tag: noindex, nofollow');
header('Cache-Control: no-store');
if ($action !== 'cover' && $action !== 'art') {
    header('Content-Type: application/json; charset=utf-8');
    // A whole-library queue is a few MB of repetitive JSON; gzip it.
    if (!ini_get('zlib.output_compression') && extension_loaded('zlib')
        && stripos((string)($_SERVER['HTTP_ACCEPT_ENCODING'] ?? ''), 'gzip') !== false) {
        ob_start('ob_gzhandler');
    }
}

// The iOS app calls this from its own page (file://), so it is cross-origin.
// Safe: nothing here rides on cookies from another site - the app sends its
// key in a header, and a browser page on another site has no key to send.
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: X-Scray-Key, Content-Type, X-Scray-Enc');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Max-Age: 86400');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }

if ($action === 'ping') jsonOut(['ok' => true, 'at' => gmdate('c')]);

// ============================================================
// AUTH
//
// Same three ways in as the rest of Scray (browse api.php / rebuild.php):
//   - a logged-in session (cookie), which is how the page talks to us;
//   - the console/admin key, in X-Scray-Key, for curl;
//   - the scanner on the gateway, which holds only audio_worker_key and can
//     call audio_worker_* and nothing else.
// The shared device key is public by design, so it gets nothing here.
// ============================================================

$secrets = @include SCRAY_SECRETS_FILE;
if (!is_array($secrets)) fail(500, 'secrets file missing or unreadable: ' . SCRAY_SECRETS_FILE);

/**
 * A per-phone key (sd_ + 64 hex) issued by Scray's device_pair. Only a SHA-256
 * of each is kept, in scray_devices.json beside the databases - the same file
 * and hash scray-devices.php writes. Read-only here: revoking a phone on
 * twofactor.php cuts it off from the audio library too.
 */
function audioDeviceKeyOk(string $key): bool {
    if (!preg_match('/^sd_[0-9a-f]{64}$/', $key)) return false;
    $raw = @file_get_contents(SCRAY_DATA_DIR . '/scray_devices.json');
    $st = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($st)) return false;
    $want = hash('sha256', 'scray-device|' . $key);
    foreach ((array)($st['devices'] ?? []) as $d) {
        if (is_array($d) && hash_equals((string)($d['hash'] ?? ''), $want)) return true;
    }
    return false;
}

// ---- art: a cover you chose, by signed link (an app <img> can't send the key) ----
if ($action === 'art') {
    $f = (string)($_GET['f'] ?? ''); $e = (int)($_GET['e'] ?? 0); $sig = (string)($_GET['s'] ?? '');
    if (!preg_match('/^[0-9a-f]{40}\.(jpg|png|webp)$/', $f) || $e < time() || !hash_equals(artSig($secrets, $f, $e), $sig)) {
        http_response_code(403); header('Content-Type: text/plain'); echo 'bad or old link'; exit;
    }
    $file = AUDIO_COVERS_DIR . '/' . $f;
    if (!is_file($file)) { http_response_code(404); header('Content-Type: text/plain'); echo 'no such cover'; exit; }
    header('Content-Type: ' . ['jpg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp'][pathinfo($f, PATHINFO_EXTENSION)]);
    header('Cache-Control: private, max-age=86400, immutable');   // the name is the content's hash
    header('Content-Length: ' . filesize($file));
    readfile($file);
    exit;
}
function artSig(array $secrets, string $f, int $e): string {
    return hash_hmac('sha256', "scray-audio-art|$f|$e", (string)($secrets['hetzner_secret'] ?? '') . '|art');
}

$isWorker = false;
if (strncmp($action, 'audio_worker_', 13) === 0) {
    $want = (string)($secrets['audio_worker_key'] ?? '');
    $got  = (string)($_SERVER['HTTP_X_SCRAY_WORKER'] ?? '');
    if ($want === '' || $got === '' || !hash_equals($want, $got)) fail(401, 'bad worker key');
    $isWorker = true;
} else {
    require_once AUDIO_AUTH_FILE;
    $key  = (string)($_SERVER['HTTP_X_SCRAY_KEY'] ?? '');
    $tier = scray_auth_tier($key);
    if (!in_array($tier, ['session', 'admin'], true) && !audioDeviceKeyOk($key)) fail(401, 'bad key - log in again');
}

// ============================================================
// DB
// ============================================================

/** Run a statement; PHP ints bind as ints (substr lengths, LIMITs). */
function run(PDO $db, string $sql, array $p = []): PDOStatement {
    $st = $db->prepare($sql);
    foreach ($p as $k => $v) {
        $type = is_int($v) ? PDO::PARAM_INT : (is_null($v) ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $st->bindValue(is_int($k) ? $k + 1 : $k, $v, $type);
    }
    $st->execute();
    return $st;
}

function audioDb(array $secrets): PDO {
    $file = (string)($secrets['audio_db'] ?? '') ?: AUDIO_DB_FILE;
    $db = new PDO('sqlite:' . $file, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $db->exec('PRAGMA journal_mode = WAL');
    $db->exec('PRAGMA busy_timeout = 5000');
    $ver = (int)$db->query('PRAGMA user_version')->fetchColumn();
    if ($ver < 1) {
        $db->beginTransaction();
        $db->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS tracks (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,          -- under /home/audio, no leading slash
  folder       TEXT NOT NULL DEFAULT '',      -- dirname of path, '' at the root
  filename     TEXT NOT NULL,
  ext          TEXT NOT NULL,
  size         INTEGER,
  etag         TEXT,
  mtime        TEXT,
  cover        TEXT,                          -- folder art file, same root as path
  title        TEXT,
  artist       TEXT NOT NULL DEFAULT '',
  album_artist TEXT NOT NULL DEFAULT 'Unknown artist',   -- the grouping key
  album        TEXT NOT NULL DEFAULT '',
  track_no     INTEGER,
  disc_no      INTEGER,
  year         INTEGER,
  genre        TEXT NOT NULL DEFAULT '',
  duration_ms  INTEGER,
  bitrate      INTEGER,
  sample_rate  INTEGER,
  channels     INTEGER,
  codec        TEXT,
  tag_error    TEXT,
  search       TEXT NOT NULL DEFAULT '',      -- lower-cased, accents removed: what search looks at
  tagged       INTEGER NOT NULL DEFAULT 0,
  scan_id      INTEGER,
  deleted      INTEGER NOT NULL DEFAULT 0,
  added_at     TEXT,
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS tracks_folder ON tracks(folder);
CREATE INDEX IF NOT EXISTS tracks_artist ON tracks(album_artist, album);
CREATE INDEX IF NOT EXISTS tracks_genre  ON tracks(genre);
CREATE TABLE IF NOT EXISTS scans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT,
  finished_at TEXT,
  files_seen  INTEGER,
  complete    INTEGER,
  pruned      INTEGER
);
SQL);
        $db->exec('PRAGMA user_version = 1');
        $db->commit();
        $ver = 1;
    }
    if ($ver < 2) {
        // live scan progress + the page's "scan now" request
        $db->beginTransaction();
        foreach (['folders INTEGER', 'tagged INTEGER', 'errors INTEGER', 'phase TEXT', 'heartbeat TEXT', 'note TEXT'] as $col) {
            $db->exec("ALTER TABLE scans ADD COLUMN $col");
        }
        $db->exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
        $db->exec('PRAGMA user_version = 2');
        $db->commit();
        $ver = 2;
    }
    if ($ver < 3) {
        // playlists. An item is one place in a playlist, so a track can appear twice.
        // It points at tracks.id; rescans keep a path's id, so renames of tags are fine,
        // while a file moved to a new path becomes a new track and drops out of the list.
        $db->beginTransaction();
        $db->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS playlists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS playlist_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  pos         INTEGER NOT NULL,
  track_id    INTEGER NOT NULL,
  added_at    TEXT
);
CREATE INDEX IF NOT EXISTS playlist_items_pl ON playlist_items(playlist_id, pos);
CREATE INDEX IF NOT EXISTS playlist_items_tr ON playlist_items(track_id);
SQL);
        $db->exec('PRAGMA user_version = 3');
        $db->commit();
        $ver = 3;
    }
    if ($ver < 4) {
        // Liked: one built-in playlist (kind = 'liked'), always there, can't be renamed or deleted.
        // A playlist you had already called "Liked" becomes it, so nothing is lost or doubled.
        $db->beginTransaction();
        $db->exec('ALTER TABLE playlists ADD COLUMN kind TEXT');
        $mine = null;
        foreach ($db->query('SELECT id, name FROM playlists ORDER BY id')->fetchAll() as $r) {
            if (foldText(trim((string)$r['name'])) === 'liked') { $mine = (int)$r['id']; break; }
        }
        $now = gmdate('c');
        if ($mine !== null) run($db, "UPDATE playlists SET kind = 'liked', name = 'Liked' WHERE id = :i", [':i' => $mine]);
        else run($db, "INSERT INTO playlists(name, kind, created_at, updated_at) VALUES ('Liked', 'liked', :t, :t)", [':t' => $now]);
        $db->exec('PRAGMA user_version = 4');
        $db->commit();
        $ver = 4;
    }
    if ($ver < 5) {
        // Edits. The tracks' title/artist/... columns become "what to show": the file's own tags (kept in
        // file_tags) with your edits (track_edits) on top. A rescan rewrites file_tags only, so edits stay.
        $db->beginTransaction();
        foreach (['file_tags TEXT', 'cover_custom TEXT', 'mb_release TEXT', 'mb_recording TEXT', 'edited INTEGER NOT NULL DEFAULT 0'] as $col) {
            $db->exec("ALTER TABLE tracks ADD COLUMN $col");
        }
        $db->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS track_edits (
  track_id  INTEGER NOT NULL,
  field     TEXT NOT NULL,         -- title, artist, album_artist, album, track_no, disc_no, year, genre, cover, mb_release, mb_recording
  value     TEXT,
  source    TEXT,                  -- manual | musicbrainz
  edited_at TEXT,
  PRIMARY KEY (track_id, field)
);
CREATE TABLE IF NOT EXISTS mb_cache (url TEXT PRIMARY KEY, body TEXT, fetched_at INTEGER);
SQL);
        // Until now the columns held the file's tags as they were, so they become file_tags as they are.
        $up = $db->prepare('UPDATE tracks SET file_tags = :j WHERE id = :i');
        foreach ($db->query('SELECT id, title, artist, album_artist, album, track_no, disc_no, year, genre FROM tracks WHERE tagged = 1')->fetchAll() as $r) {
            $aa = (string)$r['album_artist'];
            if ($aa === (string)$r['artist'] || $aa === 'Unknown artist') $aa = '';     // was a stand-in, not a tag
            $up->execute([':i' => (int)$r['id'], ':j' => json_encode([
                'title' => (string)($r['title'] ?? ''), 'artist' => (string)$r['artist'], 'album_artist' => $aa, 'album' => (string)$r['album'],
                'track_no' => $r['track_no'] === null ? null : (int)$r['track_no'], 'disc_no' => $r['disc_no'] === null ? null : (int)$r['disc_no'],
                'year' => $r['year'] === null ? null : (int)$r['year'], 'genre' => (string)$r['genre'],
            ], JSON_UNESCAPED_UNICODE)]);
        }
        $db->exec('PRAGMA user_version = 5');
        $db->commit();
        $ver = 5;
    }
    if ($ver < 6) {
        // Writing edits into the files (the gateway does it, when it is allowed to). One job per file.
        $db->beginTransaction();
        $db->exec('ALTER TABLE tracks ADD COLUMN cover_pushed TEXT');      // the chosen cover now inside the file
        $db->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS push_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id     INTEGER NOT NULL,
  path         TEXT NOT NULL,
  etag         TEXT,                -- the file as we knew it; the gateway refuses if it has changed since
  kind         TEXT NOT NULL,       -- write | undo
  changes      TEXT NOT NULL,       -- {field: new value} for the tags to change ('' = remove the tag)
  cover        TEXT,                -- a chosen cover to put inside the file (audio-covers name)
  drop_art     INTEGER NOT NULL DEFAULT 0,   -- undo: take out the picture we put in
  before       TEXT,                -- file_tags before, and the edits before, for undo
  had_art      INTEGER,             -- from the gateway: the file had a picture before
  state        TEXT NOT NULL,       -- queued | working | done | failed
  error        TEXT,
  requested_at TEXT, started_at TEXT, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS push_jobs_track ON push_jobs(track_id, id);
CREATE INDEX IF NOT EXISTS push_jobs_state ON push_jobs(state);
SQL);
        $db->exec('PRAGMA user_version = 6');
        $db->commit();
    }
    return $db;
}

try {
    $db = audioDb($secrets);
} catch (Throwable $e) {
    fail(500, 'database open failed: ' . $e->getMessage());
}

// ============================================================
// SIGNING
//
// The same recipe as scray-browse's scrayHetznerUrl(), for the gateway's /a/
// route (audio: the read-only sub-account whose root is /home/audio). It reuses
// the video settings - same gateway, same secure_link secret:
//   hetzner_base, hetzner_secret, hetzner_ttl   (scray_secrets.php)
// The hash is over the DECODED path; the URL carries the ENCODED one.
// ============================================================

function audioSignedUrl(array $secrets, string $rel): string {
    $base   = rtrim((string)($secrets['hetzner_base'] ?? ''), '/');
    $secret = (string)($secrets['hetzner_secret'] ?? '');
    if ($base === '' || $secret === '') {
        throw new RuntimeException('gateway not configured: scray_secrets.php needs hetzner_base and hetzner_secret');
    }
    $rel = ltrim($rel, '/');
    if ($rel === '') throw new RuntimeException('empty path');
    $ttl     = (int)($secrets['hetzner_ttl'] ?? 3600);
    $expires = time() + ($ttl > 0 ? $ttl : 3600);
    $md5 = rtrim(strtr(base64_encode(md5($expires . '/a/' . $rel . ' ' . $secret, true)), '+/', '-_'), '=');
    $wire = implode('/', array_map('rawurlencode', explode('/', $rel)));
    return $base . '/a/' . $wire . '?md5=' . $md5 . '&expires=' . $expires;
}

function audioTtl(array $secrets): int {
    $ttl = (int)($secrets['hetzner_ttl'] ?? 3600);
    return $ttl > 0 ? $ttl : 3600;
}

const AUDIO_MIME = [
    'mp3' => 'audio/mpeg', 'flac' => 'audio/flac', 'm4a' => 'audio/mp4', 'aac' => 'audio/aac',
    'ogg' => 'audio/ogg', 'oga' => 'audio/ogg', 'opus' => 'audio/ogg; codecs=opus', 'wav' => 'audio/wav',
];

// ============================================================
// SHAPING
// ============================================================

function likeEsc(string $s): string {
    return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $s);
}

function cleanPath(string $p): string {
    $p = trim(str_replace('\\', '/', $p), '/');
    if (preg_match('#(^|/)\.\.(/|$)#', $p)) fail(400, 'bad path');
    return preg_replace('#/+#', '/', $p);
}

const TRACK_COLS = 'id, title, artist, album_artist, album, track_no, disc_no, year, genre, duration_ms, ext, folder, filename, path, size, (cover IS NOT NULL OR cover_custom IS NOT NULL) AS has_cover, cover_custom, edited';
/** Has art: the folder's or one you chose. */
const HAS_ART = '(cover IS NOT NULL OR cover_custom IS NOT NULL)';

/** One track as the page wants it. Missing tags fall back to the file name. */
function shapeTrack(array $r): array {
    $title = trim((string)($r['title'] ?? ''));
    if ($title === '') $title = (string)pathinfo((string)$r['filename'], PATHINFO_FILENAME);
    return [
        'id'    => (int)$r['id'],
        'title' => $title,
        'artist' => (string)($r['artist'] !== '' ? $r['artist'] : $r['album_artist']),
        'albumArtist' => (string)$r['album_artist'],
        'album' => (string)$r['album'],
        'no'    => $r['track_no'] === null ? null : (int)$r['track_no'],
        'disc'  => $r['disc_no'] === null ? null : (int)$r['disc_no'],
        'year'  => $r['year'] === null ? null : (int)$r['year'],
        'genre' => (string)$r['genre'],
        'ms'    => $r['duration_ms'] === null ? null : (int)$r['duration_ms'],
        'ext'   => (string)$r['ext'],
        'folder' => (string)$r['folder'],
        'path'  => (string)$r['path'],
        'size'  => $r['size'] === null ? null : (int)$r['size'],
        'cover' => (bool)$r['has_cover'],
        // which art: changes when you pick another cover, so a saved copy on the phone knows to fetch it again
        'coverv' => ($r['cover_custom'] ?? null) ? substr((string)$r['cover_custom'], 0, 12) : ((bool)$r['has_cover'] ? 'f' : ''),
        'edited' => !empty($r['edited']),
    ];
}

/** Disc, track number, then file name - or file name alone if any number is missing. */
function sortTracks(array $rows): array {
    $allNumbered = $rows !== [];
    foreach ($rows as $r) { if ($r['track_no'] === null) { $allNumbered = false; break; } }
    usort($rows, static function (array $a, array $b) use ($allNumbered): int {
        if ($allNumbered) {
            $c = ((int)$a['disc_no']) <=> ((int)$b['disc_no']);
            if ($c === 0) $c = ((int)$a['track_no']) <=> ((int)$b['track_no']);
            if ($c !== 0) return $c;
        }
        return strnatcasecmp((string)$a['filename'], (string)$b['filename']);
    });
    return $rows;
}

/** "The Cure" sorts under C. */
function nameSortKey(string $s): string {
    $s = mb_strtolower($s, 'UTF-8');
    return preg_replace('/^(the|a|an) /u', '', $s) ?? $s;
}

/** Lower-case and strip accents, so "edith" finds "Édith". */
function foldText(string $s): string {
    $s = mb_strtolower($s, 'UTF-8');
    if (class_exists('Normalizer')) {
        $d = Normalizer::normalize($s, Normalizer::FORM_D);
        if (is_string($d)) $s = preg_replace('/\p{Mn}+/u', '', $d) ?? $d;
    }
    return $s;
}

/**
 * Folders whose path has every word of the search, top-most only (a match's sub-folders are left out),
 * with how many tracks are under each. offline.js does the same for the Offline filter.
 */
function searchFolders(PDO $db, string $q): array {
    $words = array_values(array_filter(preg_split('/\s+/u', foldText(trim($q))) ?: [], static fn($w) => $w !== ''));
    if (!$words) return [];
    $count = [];                                          // every folder, ancestors included => tracks under it
    foreach (run($db, 'SELECT folder, COUNT(*) n FROM tracks WHERE deleted = 0 GROUP BY folder')->fetchAll() as $r) {
        $segs = explode('/', (string)$r['folder']);
        for ($i = 1; $i <= count($segs); $i++) {
            $f = implode('/', array_slice($segs, 0, $i));
            if ($f === '') continue;
            $count[$f] = ($count[$f] ?? 0) + (int)$r['n'];
        }
    }
    $hit = static function (string $f) use ($words): bool {
        $s = foldText($f);
        foreach ($words as $w) if (!str_contains($s, $w)) return false;
        return true;
    };
    $out = [];
    foreach ($count as $f => $n) {
        if (!$hit((string)$f)) continue;
        $f = (string)$f;
        $parent = ($i = strrpos($f, '/')) === false ? '' : substr($f, 0, $i);
        if ($parent !== '' && isset($count[$parent]) && $hit($parent)) continue;
        $out[] = ['name' => ($i === false ? $f : substr($f, $i + 1)), 'path' => $f, 'tracks' => $n];
    }
    usort($out, static fn($a, $b) => strnatcasecmp($a['path'], $b['path']));
    return array_slice($out, 0, 100);
}

/** WHERE pieces shared by `tracks`: folder, artist, album, genre, q. */
function trackFilters(): array {
    $w = ['deleted = 0'];
    $p = [];
    if (isset($_GET['folder'])) {
        $f = cleanPath((string)$_GET['folder']);
        if ($f !== '') {
            $w[] = '(folder = :f OR substr(folder, 1, :fn) = :fp)';
            $p[':f'] = $f;
            $p[':fp'] = $f . '/';
            $p[':fn'] = mb_strlen($f . '/', 'UTF-8');
        }
    }
    if (isset($_GET['artist'])) { $w[] = 'album_artist = :aa'; $p[':aa'] = (string)$_GET['artist']; }
    if (isset($_GET['album']))  { $w[] = 'album = :al';        $p[':al'] = (string)$_GET['album']; }
    if (isset($_GET['genre']))  { $w[] = 'genre = :g';         $p[':g']  = (string)$_GET['genre']; }
    $q = trim((string)($_GET['q'] ?? ''));
    if ($q !== '') {
        $i = 0;
        foreach (preg_split('/\s+/u', foldText($q)) ?: [] as $word) {      // every word must match somewhere
            $k = ':q' . $i++;
            $w[] = "search LIKE $k ESCAPE '\\'";
            $p[$k] = '%' . likeEsc($word) . '%';
        }
    }
    return [implode(' AND ', $w), $p];
}

// ============================================================
// ACTIONS
// ============================================================

$in = [];
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $raw = (string)file_get_contents('php://input');
    // The scanner sends its payload base64-encoded: file names go through a web
    // firewall that can 403 a body containing things like ../ or select ... from.
    if (($_SERVER['HTTP_X_SCRAY_ENC'] ?? '') === 'b64') {
        $raw = (string)base64_decode($raw, true);
    }
    $in = json_decode($raw, true);
    if (!is_array($in)) fail(400, 'body is not JSON');
}


// ---- playlists ---------------------------------------------------------
const PL_MAX_NAME  = 100;
const PL_MAX_ITEMS = 50000;
const PL_MAX_BATCH = 20000;

function plName(array $in): string {
    $n = trim((string)preg_replace('/\s+/u', ' ', (string)($in['name'] ?? '')));
    if ($n === '') fail(400, 'a playlist needs a name');
    if (mb_strlen($n, 'UTF-8') > PL_MAX_NAME) fail(400, 'that name is too long (' . PL_MAX_NAME . ' characters at most)');
    return $n;
}
function plNameTaken(PDO $db, string $name, int $except = 0): bool {
    $rows = run($db, 'SELECT id, name FROM playlists')->fetchAll();   // folded in PHP: SQLite NOCASE is ASCII only
    $want = foldText($name);
    foreach ($rows as $r) if ((int)$r['id'] !== $except && foldText((string)$r['name']) === $want) return true;
    return false;
}
function plId(array $in): int {
    $id = (int)($in['id'] ?? $_GET['id'] ?? 0);
    if ($id <= 0) fail(400, 'id needed');
    return $id;
}
function plRow(PDO $db, int $id): array {
    $r = run($db, 'SELECT id, name, kind, created_at, updated_at FROM playlists WHERE id = :i', [':i' => $id])->fetch();
    if (!$r) fail(404, 'no such playlist');
    return $r;
}
/** Liked is built in: it can be added to and taken from, not renamed or deleted. */
function plNotLiked(array $row): void {
    if (($row['kind'] ?? null) === 'liked') fail(400, 'Liked is built in: it can’t be renamed or deleted');
}
function likedId(PDO $db): int {
    $id = run($db, "SELECT id FROM playlists WHERE kind = 'liked' ORDER BY id LIMIT 1")->fetchColumn();
    if ($id !== false) return (int)$id;
    $now = gmdate('c');
    run($db, "INSERT INTO playlists(name, kind, created_at, updated_at) VALUES ('Liked', 'liked', :t, :t)", [':t' => $now]);
    return (int)$db->lastInsertId();
}
/** The track ids in Liked, newest first. */
function likedIds(PDO $db, int $pl): array {
    return array_map('intval', run($db, 'SELECT DISTINCT track_id FROM playlist_items WHERE playlist_id = :p ORDER BY pos, id', [':p' => $pl])->fetchAll(PDO::FETCH_COLUMN));
}
/** Ids from the request, whole numbers only, at most $PL_MAX_BATCH. */
function plIds($v, string $what): array {
    if (!is_array($v)) fail(400, "{$what}[] needed");
    if (count($v) > PL_MAX_BATCH) fail(400, 'too many at once');
    $out = [];
    foreach ($v as $x) { $i = (int)$x; if ($i > 0) $out[] = $i; }
    return $out;
}
/** Which of these track ids exist and are not gone? */
function plLiveTrackIds(PDO $db, array $ids): array {
    $live = [];
    foreach (array_chunk(array_values(array_unique($ids)), 500) as $chunk) {
        $in = implode(',', array_fill(0, count($chunk), '?'));
        foreach (run($db, "SELECT id FROM tracks WHERE deleted = 0 AND id IN ($in)", $chunk)->fetchAll() as $r) $live[(int)$r['id']] = true;
    }
    return $live;
}
function plTouch(PDO $db, int $id): void {
    run($db, 'UPDATE playlists SET updated_at = :t WHERE id = :i', [':t' => gmdate('c'), ':i' => $id]);
}
/** Append track ids at the end, in the order given (duplicates allowed). Returns how many went in. */
function plAppend(PDO $db, int $pl, array $ids): int {
    $live = plLiveTrackIds($db, $ids);
    $ids = array_values(array_filter($ids, static fn($i) => isset($live[$i])));
    $have = (int)run($db, 'SELECT COUNT(*) FROM playlist_items WHERE playlist_id = :p', [':p' => $pl])->fetchColumn();
    if ($have + count($ids) > PL_MAX_ITEMS) fail(400, 'a playlist holds at most ' . number_format(PL_MAX_ITEMS) . ' tracks');
    $pos = (int)run($db, 'SELECT COALESCE(MAX(pos), 0) FROM playlist_items WHERE playlist_id = :p', [':p' => $pl])->fetchColumn();
    $ins = $db->prepare('INSERT INTO playlist_items(playlist_id, pos, track_id, added_at) VALUES (:p, :o, :t, :a)');
    $now = gmdate('c');
    foreach ($ids as $t) { $ins->execute([':p' => $pl, ':o' => ++$pos, ':t' => $t, ':a' => $now]); }
    plTouch($db, $pl);
    return count($ids);
}
function plRenumber(PDO $db, int $pl, array $itemIds): void {
    $up = $db->prepare('UPDATE playlist_items SET pos = :o WHERE id = :i AND playlist_id = :p');
    $o = 0;
    foreach ($itemIds as $i) $up->execute([':o' => ++$o, ':i' => $i, ':p' => $pl]);
}
function plItemIds(PDO $db, int $pl): array {
    return array_map('intval', run($db, 'SELECT id FROM playlist_items WHERE playlist_id = :p ORDER BY pos, id', [':p' => $pl])->fetchAll(PDO::FETCH_COLUMN));
}
/** A playlist's tracks in order, each with its item id ("entry"); the ones no longer in the library are counted, not listed. */
function plTracks(PDO $db, int $pl): array {
    $items = run($db, 'SELECT id, track_id FROM playlist_items WHERE playlist_id = :p ORDER BY pos, id', [':p' => $pl])->fetchAll();
    $byId = [];
    foreach (array_chunk(array_values(array_unique(array_map(static fn($r) => (int)$r['track_id'], $items))), 500) as $chunk) {
        $in = implode(',', array_fill(0, count($chunk), '?'));
        foreach (run($db, 'SELECT ' . TRACK_COLS . " FROM tracks WHERE deleted = 0 AND id IN ($in)", $chunk)->fetchAll() as $r) $byId[(int)$r['id']] = $r;
    }
    $tracks = []; $missing = 0;
    foreach ($items as $it) {
        $r = $byId[(int)$it['track_id']] ?? null;
        if ($r === null) { $missing++; continue; }
        $tracks[] = shapeTrack($r) + ['entry' => (int)$it['id']];
    }
    return [$tracks, $missing];
}

// ---- covers ------------------------------------------------------------
/** This api.php's own address, for links the app opens from elsewhere. */
function selfUrl(): string {
    $https = (($_SERVER['HTTPS'] ?? '') !== '' && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    return ($https ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . ($_SERVER['SCRIPT_NAME'] ?? '/api.php');
}
/** A signed link to a track's art: the cover you chose if any, else the folder's (via the gateway). */
function coverLink(PDO $db, array $secrets, int $id): ?string {
    $r = run($db, 'SELECT cover, cover_custom FROM tracks WHERE id = :i AND deleted = 0', [':i' => $id])->fetch();
    if (!$r) return null;
    if ($r['cover_custom']) {
        $e = time() + max(600, audioTtl($secrets));
        $f = (string)$r['cover_custom'];
        return selfUrl() . '?action=art&f=' . rawurlencode($f) . '&e=' . $e . '&s=' . artSig($secrets, $f, $e);
    }
    return $r['cover'] ? audioSignedUrl($secrets, (string)$r['cover']) : null;
}
/** Keep an image you chose. Named by its content, so the same picture is stored once. Returns the file name. */
function storeCover(string $bytes): string {
    if (strlen($bytes) > 10 * 1024 * 1024) fail(400, 'that picture is too big (10 MB at most)');
    $info = @getimagesizefromstring($bytes);
    $ext = [IMAGETYPE_JPEG => 'jpg', IMAGETYPE_PNG => 'png', IMAGETYPE_WEBP => 'webp'][$info[2] ?? 0] ?? null;
    if (!$info || $ext === null) fail(400, 'that is not a JPEG, PNG or WebP picture');
    if (!is_dir(AUDIO_COVERS_DIR) && !@mkdir(AUDIO_COVERS_DIR, 0755, true)) fail(500, 'could not make the covers folder');
    $name = sha1($bytes) . '.' . $ext;
    $file = AUDIO_COVERS_DIR . '/' . $name;
    if (!is_file($file)) {
        $tmp = $file . '.' . bin2hex(random_bytes(4));
        if (@file_put_contents($tmp, $bytes) !== strlen($bytes) || !@rename($tmp, $file)) { @unlink($tmp); fail(500, 'could not save the cover'); }
    }
    return $name;
}

// ---- edits: the file's tags (file_tags) with yours on top (track_edits) ---
const EDIT_TEXT = ['title' => 300, 'artist' => 300, 'album_artist' => 300, 'album' => 300, 'genre' => 120];
const EDIT_INT  = ['track_no' => 999, 'disc_no' => 99, 'year' => 9999];
const EDIT_META = ['cover', 'mb_release', 'mb_recording'];

/** Work out what to show for these tracks from their file tags and edits, and store it. */
function trackApply(PDO $db, array $ids): void {
    $ids = array_values(array_unique(array_map('intval', $ids)));
    if (!$ids) return;
    $up = $db->prepare('UPDATE tracks SET title = :title, artist = :artist, album_artist = :aa, album = :album, track_no = :no,
                          disc_no = :disc, year = :year, genre = :genre, cover_custom = :cc, mb_release = :rel, mb_recording = :rec,
                          edited = :ed, search = :search WHERE id = :id');
    foreach (array_chunk($ids, 400) as $chunk) {
        $in = implode(',', array_fill(0, count($chunk), '?'));
        $edits = [];
        foreach (run($db, "SELECT track_id, field, value FROM track_edits WHERE track_id IN ($in)", $chunk)->fetchAll() as $e) {
            $edits[(int)$e['track_id']][(string)$e['field']] = $e['value'];
        }
        foreach (run($db, "SELECT id, path, file_tags FROM tracks WHERE id IN ($in)", $chunk)->fetchAll() as $r) {
            $id = (int)$r['id'];
            $f = json_decode((string)($r['file_tags'] ?? ''), true) ?: [];
            $e = $edits[$id] ?? [];
            $pick = static fn(string $k) => array_key_exists($k, $e) ? $e[$k] : ($f[$k] ?? null);
            $str = static fn($v): string => trim((string)($v ?? ''));
            $int = static fn($v): ?int => ($v === null || $v === '' || !is_numeric($v) || (int)$v <= 0) ? null : (int)$v;
            $title = $str($pick('title')); $artist = $str($pick('artist')); $album = $str($pick('album'));
            $aa = $str($pick('album_artist'));
            if ($aa === '') $aa = $artist;
            if ($aa === '') $aa = 'Unknown artist';
            $shown = array_diff_key($e, array_flip(['mb_release', 'mb_recording']));
            $up->execute([
                ':id' => $id, ':title' => $title === '' ? null : $title, ':artist' => $artist, ':aa' => $aa, ':album' => $album,
                ':no' => $int($pick('track_no')), ':disc' => $int($pick('disc_no')), ':year' => $int($pick('year')),
                ':genre' => $str($pick('genre')), ':cc' => ($e['cover'] ?? null) ?: null,
                ':rel' => $e['mb_release'] ?? null, ':rec' => $e['mb_recording'] ?? null, ':ed' => $shown ? 1 : 0,
                ':search' => foldText(implode(' ', [$title, $artist, $aa, $album, (string)$r['path']])),
            ]);
        }
    }
}

/** Set (or with null, clear) fields on one track. A value the same as the file's tag clears the edit too. */
function trackEdit(PDO $db, int $id, array $set, string $source): void {
    $row = run($db, 'SELECT file_tags FROM tracks WHERE id = :i AND deleted = 0', [':i' => $id])->fetch();
    if (!$row) fail(404, "no such track ($id)");
    $file = json_decode((string)($row['file_tags'] ?? ''), true) ?: [];
    $put = $db->prepare('INSERT INTO track_edits(track_id, field, value, source, edited_at) VALUES (:t, :f, :v, :s, :a)
                         ON CONFLICT(track_id, field) DO UPDATE SET value = excluded.value, source = excluded.source, edited_at = excluded.edited_at');
    $del = $db->prepare('DELETE FROM track_edits WHERE track_id = :t AND field = :f');
    foreach ($set as $field => $v) {
        $field = (string)$field;
        if (isset(EDIT_TEXT[$field])) {
            if ($v !== null) $v = mb_substr(trim(preg_replace('/\s+/u', ' ', (string)$v)), 0, EDIT_TEXT[$field], 'UTF-8');
            $same = $v !== null && $v === trim((string)($file[$field] ?? ''));
        } elseif (isset(EDIT_INT[$field])) {
            if ($v !== null) {
                if ($v === '' ) $v = '';
                elseif (!is_numeric($v) || (int)$v < 1 || (int)$v > EDIT_INT[$field]) fail(400, "$field should be a number from 1 to " . EDIT_INT[$field]);
                else $v = (string)(int)$v;
            }
            $fv = $file[$field] ?? null;
            $same = $v !== null && $v === ($fv === null ? '' : (string)(int)$fv);
        } elseif (in_array($field, EDIT_META, true)) {
            if ($v !== null) $v = substr((string)$v, 0, 100);
            $same = false;
        } else {
            fail(400, "can't edit $field");
        }
        if ($v === null || $same) $del->execute([':t' => $id, ':f' => $field]);
        else $put->execute([':t' => $id, ':f' => $field, ':v' => $v, ':s' => $source, ':a' => gmdate('c')]);
    }
}

function shapeById(PDO $db, array $ids): array {
    $out = [];
    foreach (array_chunk(array_values(array_unique(array_map('intval', $ids))), 400) as $chunk) {
        $in = implode(',', array_fill(0, count($chunk), '?'));
        foreach (run($db, 'SELECT ' . TRACK_COLS . " FROM tracks WHERE deleted = 0 AND id IN ($in)", $chunk)->fetchAll() as $r) $out[(int)$r['id']] = shapeTrack($r);
    }
    $sorted = [];
    foreach ($ids as $i) if (isset($out[(int)$i])) $sorted[] = $out[(int)$i];
    return $sorted;
}

// ---- writing edits into the files (option B) ---------------------------------
// The page asks; api.php queues one job per file; the gateway (scray-audio-scan.py --poll, only with
// SCRAY_WRITE_TAGS=1) downloads the file, writes the tags, checks them, uploads it beside the original and
// swaps it in. Each job keeps what the file and the edits were before, so it can be undone.
const PUSH_FIELDS = ['title', 'artist', 'album_artist', 'album', 'track_no', 'disc_no', 'year', 'genre'];
const PUSH_STUCK_SECS = 1800;

/** For each track: what writing would change ({field: new}, and the cover), and its latest job. */
function pushState(PDO $db, array $ids): array {
    $out = [];
    foreach (array_chunk(array_values(array_unique(array_map('intval', $ids))), 400) as $chunk) {
        $in = implode(',', array_fill(0, count($chunk), '?'));
        $edits = [];
        foreach (run($db, "SELECT track_id, field, value FROM track_edits WHERE track_id IN ($in)", $chunk)->fetchAll() as $e) $edits[(int)$e['track_id']][$e['field']] = $e['value'];
        $jobs = [];
        foreach (run($db, "SELECT j.* FROM push_jobs j JOIN (SELECT track_id, MAX(id) m FROM push_jobs WHERE track_id IN ($in) GROUP BY track_id) x ON x.m = j.id", $chunk)->fetchAll() as $j) $jobs[(int)$j['track_id']] = $j;
        foreach (run($db, "SELECT id, path, ext, etag, file_tags, cover_custom, cover_pushed FROM tracks WHERE deleted = 0 AND id IN ($in)", $chunk)->fetchAll() as $r) {
            $id = (int)$r['id'];
            $file = json_decode((string)($r['file_tags'] ?? ''), true) ?: [];
            $ch = [];
            foreach (PUSH_FIELDS as $f) if (array_key_exists($f, $edits[$id] ?? [])) $ch[$f] = (string)($edits[$id][$f] ?? '');
            $cover = $r['cover_custom'] && $r['cover_custom'] !== $r['cover_pushed'] ? (string)$r['cover_custom'] : null;
            $j = $jobs[$id] ?? null;
            $out[$id] = ['id' => $id, 'path' => (string)$r['path'], 'ext' => (string)$r['ext'], 'etag' => $r['etag'], 'file' => $file, 'edits' => $edits[$id] ?? [],
                'changes' => $ch, 'cover' => $cover, 'writable' => in_array($r['ext'], ['mp3', 'flac', 'm4a', 'ogg', 'oga', 'opus'], true),
                'job' => $j ? ['id' => (int)$j['id'], 'kind' => $j['kind'], 'state' => $j['state'], 'error' => $j['error'], 'at' => $j['finished_at'] ?: $j['requested_at']] : null,
                'undo' => $j && $j['kind'] === 'write' && $j['state'] === 'done'];
        }
    }
    return $out;
}
function pushGateway(PDO $db): array {
    $seen = metaGet($db, 'worker_seen_at');
    $age = secsSince($seen);
    return ['seen' => $seen, 'online' => $age !== null && $age < WORKER_SEEN_SECS, 'can_write' => metaGet($db, 'push_can_write') === '1'];
}
function pushUnstick(PDO $db): void {
    run($db, "UPDATE push_jobs SET state = 'failed', error = 'the gateway stopped part-way; the file was not swapped', finished_at = :n
              WHERE state = 'working' AND started_at < :t", [':n' => gmdate('c'), ':t' => gmdate('c', time() - PUSH_STUCK_SECS)]);
}

// ---- MusicBrainz + the Cover Art Archive ----------------------------------
// About one request a second, and every request says who we are (their rules). Answers are kept a week.
function mbUserAgent(array $secrets): string {
    $c = (string)($secrets['musicbrainz_contact'] ?? '') ?: 'https://github.com/mac-nuge/scray-audio';
    return "ScrayAudio/1.12 ( $c )";
}
/** GET a URL. Returns [status, body, content-type]. */
function httpGet(string $url, string $ua, string $accept, int $timeout = 20): array {
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 5,
            CURLOPT_TIMEOUT => $timeout, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_USERAGENT => $ua, CURLOPT_HTTPHEADER => ['Accept: ' . $accept]]);
        $body = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $type = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        curl_close($ch);
        return [$body === false ? 0 : $code, $body === false ? '' : (string)$body, $type];
    }
    $ctx = stream_context_create(['http' => ['header' => "User-Agent: $ua\r\nAccept: $accept\r\n", 'timeout' => $timeout, 'ignore_errors' => true, 'follow_location' => 1, 'max_redirects' => 5]]);
    $body = @file_get_contents($url, false, $ctx);
    $code = 0; $type = '';
    foreach ($http_response_header ?? [] as $hl) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $hl, $m)) $code = (int)$m[1];
        elseif (stripos($hl, 'content-type:') === 0) $type = trim(substr($hl, 13));
    }
    return [$body === false ? 0 : $code, $body === false ? '' : (string)$body, $type];
}
/** A MusicBrainz web-service call (path under /ws/2), cached, at most one a second across all requests. */
function mbGet(PDO $db, array $secrets, string $path, array $q): array {
    $q['fmt'] = 'json';
    $url = AUDIO_MB_BASE . '/' . ltrim($path, '/') . '?' . http_build_query($q, '', '&', PHP_QUERY_RFC3986);
    $hit = run($db, 'SELECT body FROM mb_cache WHERE url = :u AND fetched_at > :t', [':u' => $url, ':t' => time() - 7 * 86400])->fetchColumn();
    if ($hit !== false) return json_decode((string)$hit, true) ?: [];
    $lock = @fopen(SCRAY_DATA_DIR . '/audio-mb.lock', 'c');
    if ($lock) flock($lock, LOCK_EX);
    try {
        $last = (float)(metaGet($db, 'mb_last') ?? 0);
        $wait = $last + 1.1 - microtime(true);
        if ($wait > 0) usleep((int)($wait * 1e6));
        [$code, $body] = httpGet($url, mbUserAgent($secrets), 'application/json');
        metaSet($db, 'mb_last', (string)microtime(true));
    } finally {
        if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
    }
    if ($code === 503) fail(503, 'MusicBrainz is busy - try again in a few seconds');
    if ($code === 404) fail(404, 'MusicBrainz doesn’t know that one');
    if ($code !== 200) fail(502, $code ? "MusicBrainz answered $code" : 'couldn’t reach MusicBrainz');
    $j = json_decode($body, true);
    if (!is_array($j)) fail(502, 'MusicBrainz sent something unreadable');
    run($db, 'INSERT INTO mb_cache(url, body, fetched_at) VALUES (:u, :b, :t) ON CONFLICT(url) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at',
        [':u' => $url, ':b' => $body, ':t' => time()]);
    return $j;
}
function mbCredit($credits): string {
    $s = '';
    foreach ((array)$credits as $c) $s .= (string)($c['name'] ?? ($c['artist']['name'] ?? '')) . (string)($c['joinphrase'] ?? '');
    return trim($s);
}
function mbLucene(string $s): string {
    return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], trim($s)) . '"';
}

// ---- scan status -------------------------------------------------------
// A scan is "running" while its heartbeat is fresh; one that stopped updating
// without finishing is "stale" (the scanner crashed or the gateway went away).
const SCAN_STALE_SECS  = 300;
const WORKER_SEEN_SECS = 120;   // the gateway polls every 30 s
const CLAIM_SECS       = 120;   // from "scanner took the request" to "scan started"

function metaGet(PDO $db, string $k): ?string {
    $v = run($db, 'SELECT v FROM meta WHERE k = :k', [':k' => $k])->fetchColumn();
    return $v === false ? null : (string)$v;
}
function metaSet(PDO $db, string $k, ?string $v): void {
    if ($v === null) { run($db, 'DELETE FROM meta WHERE k = :k', [':k' => $k]); return; }
    run($db, 'INSERT INTO meta(k, v) VALUES (:k, :v) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [':k' => $k, ':v' => $v]);
}
function secsSince(?string $iso): ?int {
    $t = $iso ? strtotime($iso) : false;
    return $t === false ? null : max(0, time() - $t);
}

function scanStatus(PDO $db): array {
    $scan = run($db, 'SELECT id, started_at, finished_at, files_seen, folders, tagged, errors, phase, heartbeat, note, complete, pruned
                        FROM scans ORDER BY id DESC LIMIT 1')->fetch() ?: null;
    $beat = $scan ? secsSince($scan['heartbeat'] ?: $scan['started_at']) : null;
    $open = $scan && !$scan['finished_at'];
    $running = $open && $beat !== null && $beat < SCAN_STALE_SECS;
    $stale   = $open && !$running;
    $claimed = secsSince(metaGet($db, 'scan_claimed_at'));
    $state = 'idle';
    if ($running) $state = 'running';
    elseif ($claimed !== null && $claimed < CLAIM_SECS) $state = 'starting';
    elseif (metaGet($db, 'scan_requested_at') !== null) $state = 'requested';
    $seen = secsSince(metaGet($db, 'worker_seen_at'));
    $expected = (int)run($db, 'SELECT files_seen FROM scans WHERE complete = 1 AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1')->fetchColumn();
    if ($scan) {
        foreach (['id', 'files_seen', 'folders', 'tagged', 'errors', 'complete', 'pruned'] as $c) $scan[$c] = $scan[$c] === null ? null : (int)$scan[$c];
        $scan['elapsed'] = $running ? secsSince($scan['started_at']) : null;
        $scan['stale'] = $stale;
        $scan['beat_age'] = $beat;
    }
    return [
        'ok' => true, 'state' => $state, 'scan' => $scan, 'expected' => $expected,
        'tracks' => (int)run($db, 'SELECT COUNT(*) FROM tracks WHERE deleted = 0')->fetchColumn(),
        'worker_age' => $seen, 'worker_online' => $running || ($seen !== null && $seen < WORKER_SEEN_SECS),
    ];
}

try {
switch ($action) {

// ---- stats: the numbers on the front page -----------------------------
case 'stats': {
    $r = run($db, "SELECT COUNT(*) tracks, COUNT(DISTINCT album_artist) artists,
                          COUNT(DISTINCT album_artist || char(31) || album) albums,
                          COUNT(DISTINCT CASE WHEN genre <> '' THEN genre END) genres,
                          COALESCE(SUM(duration_ms), 0) ms
                     FROM tracks WHERE deleted = 0")->fetch();
    $scan = run($db, 'SELECT id, started_at, finished_at, files_seen, complete, pruned FROM scans ORDER BY id DESC LIMIT 1')->fetch() ?: null;
    $untagged = (int)run($db, 'SELECT COUNT(*) FROM tracks WHERE deleted = 0 AND tagged = 0')->fetchColumn();
    jsonOut(['ok' => true] + array_map('intval', $r) + ['untagged' => $untagged, 'scan' => $scan]);
}

// ---- ls: one folder, as a file manager shows it -----------------------
case 'ls': {
    $path   = cleanPath((string)($_GET['path'] ?? ''));
    $prefix = $path === '' ? '' : $path . '/';
    $rows = run($db, 'SELECT ' . TRACK_COLS . ' FROM tracks WHERE deleted = 0 AND folder = :f', [':f' => $path])->fetchAll();
    $tracks = array_map('shapeTrack', sortTracks($rows));

    // Immediate sub-folders: group every deeper folder under its first segment.
    $stmt = run($db, "SELECT folder, COUNT(*) c FROM tracks
                       WHERE deleted = 0 AND folder <> :f AND substr(folder, 1, :n) = :p
                       GROUP BY folder",
        [':f' => $path, ':n' => mb_strlen($prefix, 'UTF-8'), ':p' => $prefix]);
    $seg = [];
    foreach ($stmt->fetchAll() as $r) {
        $rest = substr((string)$r['folder'], strlen($prefix));
        $name = ($i = strpos($rest, '/')) === false ? $rest : substr($rest, 0, $i);
        if ($name === '') continue;
        $seg[$name] = ($seg[$name] ?? 0) + (int)$r['c'];
    }
    uksort($seg, 'strnatcasecmp');
    $folders = [];
    foreach ($seg as $name => $c) $folders[] = ['name' => (string)$name, 'path' => $prefix . $name, 'tracks' => $c];

    $art = run($db, 'SELECT id FROM tracks WHERE deleted = 0 AND folder = :f AND (cover IS NOT NULL OR cover_custom IS NOT NULL) LIMIT 1', [':f' => $path])->fetchColumn();
    jsonOut(['ok' => true, 'path' => $path, 'folders' => $folders, 'tracks' => $tracks,
             'art' => $art === false ? null : (int)$art, 'total' => count($tracks) + array_sum($seg)]);
}

// ---- tracks: a flat list under any filter (queues, album pages, genres) -
case 'tracks': {
    [$where, $p] = trackFilters();
    $limit = max(1, min(100000, (int)($_GET['limit'] ?? 5000)));
    $order = ((string)($_GET['order'] ?? 'album')) === 'path'
        ? 'folder COLLATE NOCASE, filename COLLATE NOCASE'
        : 'album_artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, filename COLLATE NOCASE';
    $rows = run($db, "SELECT " . TRACK_COLS . " FROM tracks WHERE $where ORDER BY $order LIMIT :lim", $p + [':lim' => $limit])->fetchAll();
    // One album read in order: use the same disc/track logic as a folder.
    if (isset($_GET['album']) && (isset($_GET['artist']) || isset($_GET['folder']))) $rows = sortTracks($rows);
    jsonOut(['ok' => true, 'tracks' => array_map('shapeTrack', $rows), 'capped' => count($rows) >= $limit]);
}

// ---- artists / albums / genres: the metadata views --------------------
case 'artists': {
    $rows = run($db, "SELECT album_artist AS name, COUNT(DISTINCT album) albums, COUNT(*) tracks,
                             MIN(CASE WHEN cover IS NOT NULL OR cover_custom IS NOT NULL THEN id END) art
                        FROM tracks WHERE deleted = 0 GROUP BY album_artist")->fetchAll();
    usort($rows, static fn($a, $b) => strcmp(nameSortKey((string)$a['name']), nameSortKey((string)$b['name'])));
    jsonOut(['ok' => true, 'artists' => array_map(static fn($r) => [
        'name' => (string)$r['name'], 'albums' => (int)$r['albums'], 'tracks' => (int)$r['tracks'],
        'art' => $r['art'] === null ? null : (int)$r['art'],
    ], $rows)]);
}

case 'albums': {
    $w = ['deleted = 0'];
    $p = [];
    if (isset($_GET['artist'])) { $w[] = 'album_artist = :aa'; $p[':aa'] = (string)$_GET['artist']; }
    else { $w[] = "album <> ''"; }                // the grid is real albums; an artist page also shows the loose tracks
    $rows = run($db, "SELECT album_artist AS artist, album, MAX(year) year, COUNT(*) tracks,
                             COALESCE(SUM(duration_ms), 0) ms,
                             MIN(CASE WHEN cover IS NOT NULL OR cover_custom IS NOT NULL THEN id END) art
                        FROM tracks WHERE " . implode(' AND ', $w) . " GROUP BY album_artist, album", $p)->fetchAll();
    usort($rows, static function ($a, $b) {
        $c = strcmp(nameSortKey((string)$a['artist']), nameSortKey((string)$b['artist']));
        if ($c === 0) $c = ((int)$a['year']) <=> ((int)$b['year']);
        return $c !== 0 ? $c : strcmp(nameSortKey((string)$a['album']), nameSortKey((string)$b['album']));
    });
    jsonOut(['ok' => true, 'albums' => array_map(static fn($r) => [
        'artist' => (string)$r['artist'], 'album' => (string)$r['album'],
        'year' => $r['year'] === null ? null : (int)$r['year'], 'tracks' => (int)$r['tracks'], 'ms' => (int)$r['ms'],
        'art' => $r['art'] === null ? null : (int)$r['art'],
    ], $rows)]);
}

case 'genres': {
    $rows = run($db, "SELECT genre AS name, COUNT(*) tracks FROM tracks
                       WHERE deleted = 0 AND genre <> '' GROUP BY genre")->fetchAll();
    usort($rows, static fn($a, $b) => strcasecmp((string)$a['name'], (string)$b['name']));
    jsonOut(['ok' => true, 'genres' => array_map(static fn($r) => ['name' => (string)$r['name'], 'tracks' => (int)$r['tracks']], $rows)]);
}

// ---- search: tracks + artists + albums in one go ----------------------
case 'search': {
    $q = trim((string)($_GET['q'] ?? ''));
    if ($q === '') jsonOut(['ok' => true, 'tracks' => [], 'artists' => [], 'albums' => [], 'folders' => []]);
    [$where, $p] = trackFilters();
    $tracks = run($db, "SELECT " . TRACK_COLS . " FROM tracks WHERE $where
                         ORDER BY album_artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no LIMIT 300", $p)->fetchAll();
    $fq = foldText($q);
    $artists = array_values(array_filter(
        run($db, "SELECT album_artist AS name, COUNT(*) tracks FROM tracks WHERE deleted = 0 GROUP BY album_artist")->fetchAll(),
        static fn($r) => str_contains(foldText((string)$r['name']), $fq)));
    $albums = array_values(array_filter(
        run($db, "SELECT album_artist AS artist, album, MAX(year) year, COUNT(*) tracks,
                         MIN(CASE WHEN cover IS NOT NULL OR cover_custom IS NOT NULL THEN id END) art
                    FROM tracks WHERE deleted = 0 AND album <> '' GROUP BY album_artist, album")->fetchAll(),
        static fn($r) => str_contains(foldText((string)$r['album']), $fq)));
    jsonOut(['ok' => true,
        'tracks'  => array_map('shapeTrack', $tracks),
        'artists' => array_map(static fn($r) => ['name' => (string)$r['name'], 'tracks' => (int)$r['tracks']], array_slice($artists, 0, 30)),
        'albums'  => array_map(static fn($r) => [
            'artist' => (string)$r['artist'], 'album' => (string)$r['album'],
            'year' => $r['year'] === null ? null : (int)$r['year'], 'tracks' => (int)$r['tracks'],
            'art' => $r['art'] === null ? null : (int)$r['art'],
        ], array_slice($albums, 0, 40)),
        'folders' => searchFolders($db, $q)]);
}

// ---- url: a signed, expiring link to play one track -------------------
case 'url': {
    $id = (int)($_GET['id'] ?? 0);
    $r = run($db, 'SELECT path, ext FROM tracks WHERE id = :i AND deleted = 0', [':i' => $id])->fetch();
    if (!$r) fail(404, 'no such track');
    jsonOut(['ok' => true, 'url' => audioSignedUrl($secrets, (string)$r['path']),
             'mime' => AUDIO_MIME[$r['ext']] ?? 'audio/mpeg', 'expires_in' => audioTtl($secrets)]);
}

// ---- cover: <img src> target; redirects to a signed link for the art ---
// The app's <img> cannot send the key header, so it asks here (with the header)
// for the signed link and uses that as the image address.
case 'cover_url': {
    $id = (int)($_GET['t'] ?? 0);
    $u = coverLink($db, $secrets, $id);
    if ($u === null) fail(404, 'no cover');
    jsonOut(['ok' => true, 'url' => $u, 'expires_in' => max(60, audioTtl($secrets) - 300)]);
}

case 'cover': {
    $id = (int)($_GET['t'] ?? 0);
    $u = coverLink($db, $secrets, $id);
    if ($u === null) { http_response_code(404); header('Content-Type: text/plain'); echo 'no cover'; exit; }
    $keep = max(60, audioTtl($secrets) - 300);          // the redirect must not outlive the link it points at
    header('Cache-Control: private, max-age=' . $keep);
    header('Location: ' . $u, true, 302);
    exit;
}

// ============================================================
// THE SCANNER (gateway/scray-audio-scan.py)
//
// start  -> a scan id.
// seen   -> files found in a batch of folders. New or changed ones are marked
//           untagged and handed back as `need`.
// tags   -> the tags the scanner read for those.
// finish -> files that were not seen this time are marked deleted - but only
//           for a complete walk, and never if it would wipe most of the library
//           (an empty or half-failed listing must not empty the player).
// ============================================================

// ---- playlists --------------------------------------------------------
case 'playlists': {
    likedId($db);                                         // always listed, even before anything is liked
    $rows = run($db, "SELECT p.id, p.name, p.kind, p.updated_at,
                             COUNT(t.id) AS tracks, COALESCE(SUM(t.duration_ms), 0) AS ms,
                             COUNT(i.id) - COUNT(t.id) AS missing,
                             (SELECT t2.id FROM playlist_items i2 JOIN tracks t2 ON t2.id = i2.track_id
                               WHERE i2.playlist_id = p.id AND t2.deleted = 0 AND (t2.cover IS NOT NULL OR t2.cover_custom IS NOT NULL)
                               ORDER BY i2.pos LIMIT 1) AS art
                        FROM playlists p
                        LEFT JOIN playlist_items i ON i.playlist_id = p.id
                        LEFT JOIN tracks t ON t.id = i.track_id AND t.deleted = 0
                       GROUP BY p.id")->fetchAll();
    usort($rows, static fn($a, $b) => (($b['kind'] === 'liked') <=> ($a['kind'] === 'liked'))
        ?: strcmp(foldText((string)$a['name']), foldText((string)$b['name'])));
    jsonOut(['ok' => true, 'playlists' => array_map(static fn($r) => [
        'id' => (int)$r['id'], 'name' => (string)$r['name'], 'liked' => $r['kind'] === 'liked', 'tracks' => (int)$r['tracks'], 'ms' => (int)$r['ms'],
        'missing' => (int)$r['missing'], 'art' => $r['art'] === null ? null : (int)$r['art'], 'updated' => $r['updated_at'],
    ], $rows)]);
}

case 'playlist': {
    $pl = plRow($db, plId($in));
    [$tracks, $missing] = plTracks($db, (int)$pl['id']);
    $ms = 0; $art = null;
    foreach ($tracks as $t) { $ms += (int)($t['ms'] ?? 0); if ($art === null && $t['cover']) $art = $t['id']; }
    jsonOut(['ok' => true, 'playlist' => ['id' => (int)$pl['id'], 'name' => (string)$pl['name'], 'liked' => ($pl['kind'] ?? null) === 'liked', 'tracks' => count($tracks), 'ms' => $ms, 'missing' => $missing, 'art' => $art],
             'tracks' => $tracks]);
}

// ---- editing what a track says -------------------------------------------
// track_info: the file's tags, your edits and what is shown, for the edit form.
case 'track_info': {
    $id = (int)($_GET['id'] ?? 0);
    $r = run($db, 'SELECT ' . TRACK_COLS . ', file_tags, mb_release, mb_recording FROM tracks WHERE id = :i AND deleted = 0', [':i' => $id])->fetch();
    if (!$r) fail(404, 'no such track');
    $edits = [];
    foreach (run($db, 'SELECT field, value, source, edited_at FROM track_edits WHERE track_id = :i', [':i' => $id])->fetchAll() as $e) {
        $edits[$e['field']] = ['value' => $e['value'], 'source' => $e['source'], 'at' => $e['edited_at']];
    }
    jsonOut(['ok' => true, 'track' => shapeTrack($r), 'file' => json_decode((string)($r['file_tags'] ?? ''), true) ?: null,
             'edits' => (object)$edits, 'mb' => ['release' => $r['mb_release'], 'recording' => $r['mb_recording']]]);
}

// edit: items[] of {id, set: {field: value | null}}. null (or the file's own value) goes back to the file's tag.
case 'edit': {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'POST only');
    $items = $in['items'] ?? null;
    if (!is_array($items) || !$items) fail(400, 'items[] needed');
    if (count($items) > 5000) fail(400, 'too many at once');
    $source = ($in['source'] ?? '') === 'musicbrainz' ? 'musicbrainz' : 'manual';
    $db->beginTransaction();
    $ids = [];
    foreach ($items as $it) {
        $id = (int)($it['id'] ?? 0);
        if ($id <= 0 || !is_array($it['set'] ?? null)) fail(400, 'each item needs id and set');
        trackEdit($db, $id, $it['set'], $source);
        $ids[] = $id;
    }
    trackApply($db, $ids);
    $db->commit();
    jsonOut(['ok' => true, 'tracks' => shapeById($db, $ids)]);
}

// edit_reset: back to the file's tags. fields[] limits it (e.g. ["cover"]); without it, everything.
case 'edit_reset': {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'POST only');
    $ids = plIds($in['track_ids'] ?? null, 'track_ids');
    $fields = isset($in['fields']) && is_array($in['fields']) ? array_values(array_map('strval', $in['fields'])) : null;
    $db->beginTransaction();
    $n = 0;
    foreach ($ids as $id) {
        if ($fields === null) $n += run($db, 'DELETE FROM track_edits WHERE track_id = :t', [':t' => $id])->rowCount();
        else foreach ($fields as $f) $n += run($db, 'DELETE FROM track_edits WHERE track_id = :t AND field = :f', [':t' => $id, ':f' => $f])->rowCount();
    }
    trackApply($db, $ids);
    $db->commit();
    jsonOut(['ok' => true, 'cleared' => $n, 'tracks' => shapeById($db, $ids)]);
}

// tracks_by_id: fresh details for tracks the phone has saved (so edits reach the offline copies).
case 'tracks_by_id': {
    $ids = plIds($in['ids'] ?? null, 'ids');
    jsonOut(['ok' => true, 'tracks' => shapeById($db, $ids)]);
}

// ---- writing edits into the files ------------------------------------------------
case 'push_status': {
    pushUnstick($db);
    $ids = array_values(array_filter(array_map('intval', explode(',', (string)($_GET['ids'] ?? ''))), static fn($i) => $i > 0));
    if (count($ids) > 5000) fail(400, 'too many at once');
    $st = pushState($db, $ids);
    $tracks = [];
    foreach ($st as $id => $t) $tracks[] = ['changes' => (object)$t['changes'], 'now' => (object)$t['file']] + array_diff_key($t, ['file' => 1, 'edits' => 1, 'etag' => 1]);
    jsonOut(['ok' => true, 'gateway' => pushGateway($db), 'tracks' => $tracks,
             'queued' => (int)run($db, "SELECT COUNT(*) FROM push_jobs WHERE state IN ('queued', 'working')")->fetchColumn()]);
}

case 'push_request': {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'POST only');
    $ids = plIds($in['track_ids'] ?? null, 'track_ids');
    $db->beginTransaction();
    $n = 0; $skipped = [];
    $ins = $db->prepare("INSERT INTO push_jobs(track_id, path, etag, kind, changes, cover, before, state, requested_at)
                         VALUES (:t, :p, :e, 'write', :c, :cv, :b, 'queued', :n)");
    foreach (pushState($db, $ids) as $id => $t) {
        if (!$t['changes'] && !$t['cover']) continue;
        if (!$t['writable']) { $skipped[] = $t['path'] . ' (' . $t['ext'] . ' files can’t be written)'; continue; }
        if ($t['job'] && in_array($t['job']['state'], ['queued', 'working'], true)) continue;
        $ins->execute([':t' => $id, ':p' => $t['path'], ':e' => $t['etag'], ':c' => json_encode($t['changes'], JSON_UNESCAPED_UNICODE),
                       ':cv' => $t['cover'], ':b' => json_encode(['file' => $t['file'], 'edits' => $t['edits']], JSON_UNESCAPED_UNICODE), ':n' => gmdate('c')]);
        $n++;
    }
    $db->commit();
    jsonOut(['ok' => true, 'queued' => $n, 'skipped' => $skipped, 'gateway' => pushGateway($db)]);
}

// Put the files (and the edits) back as they were before the last write.
case 'push_undo': {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'POST only');
    $ids = plIds($in['track_ids'] ?? null, 'track_ids');
    $db->beginTransaction();
    $n = 0;
    $ins = $db->prepare("INSERT INTO push_jobs(track_id, path, etag, kind, changes, cover, drop_art, before, state, requested_at)
                         VALUES (:t, :p, :e, 'undo', :c, NULL, :d, :b, 'queued', :n)");
    foreach (pushState($db, $ids) as $id => $t) {
        if (!$t['undo']) continue;
        $w = run($db, 'SELECT * FROM push_jobs WHERE id = :i', [':i' => $t['job']['id']])->fetch();
        $before = json_decode((string)$w['before'], true) ?: [];
        $back = [];
        foreach (array_keys(json_decode((string)$w['changes'], true) ?: []) as $f) $back[$f] = (string)($before['file'][$f] ?? '');
        $ins->execute([':t' => $id, ':p' => $t['path'], ':e' => $t['etag'], ':c' => json_encode($back, JSON_UNESCAPED_UNICODE),
                       ':d' => $w['cover'] && !$w['had_art'] ? 1 : 0, ':b' => $w['before'], ':n' => gmdate('c')]);
        $n++;
    }
    $db->commit();
    jsonOut(['ok' => true, 'queued' => $n, 'gateway' => pushGateway($db)]);
}

// ---- MusicBrainz: find the release, then read it -----------------------------
case 'mb_search': {
    $artist = trim((string)($_GET['artist'] ?? '')); $album = trim((string)($_GET['album'] ?? '')); $q = trim((string)($_GET['q'] ?? ''));
    if ($q === '' && $album === '') fail(400, 'album or q needed');
    $query = $q !== '' ? $q : ('release:' . mbLucene($album) . ($artist !== '' && $artist !== 'Unknown artist' ? ' AND artist:' . mbLucene($artist) : ''));
    $j = mbGet($db, $secrets, 'release', ['query' => $query, 'limit' => 20]);
    $out = [];
    foreach ((array)($j['releases'] ?? []) as $r) {
        $formats = [];
        foreach ((array)($r['media'] ?? []) as $m) $formats[] = (string)($m['format'] ?? '?');
        $out[] = [
            'id' => (string)$r['id'], 'title' => (string)($r['title'] ?? ''), 'artist' => mbCredit($r['artist-credit'] ?? []),
            'date' => (string)($r['date'] ?? ''), 'country' => (string)($r['country'] ?? ''), 'tracks' => (int)($r['track-count'] ?? 0),
            'discs' => count($formats), 'format' => implode(' + ', array_unique($formats)), 'status' => (string)($r['status'] ?? ''),
            'type' => (string)($r['release-group']['primary-type'] ?? ''), 'note' => (string)($r['disambiguation'] ?? ''),
            'score' => (int)($r['score'] ?? 0),
        ];
    }
    jsonOut(['ok' => true, 'query' => $query, 'releases' => $out]);
}

case 'mb_release': {
    $rid = (string)($_GET['id'] ?? '');
    if (!preg_match('/^[0-9a-f-]{36}$/', $rid)) fail(400, 'a MusicBrainz release id is needed');
    $r = mbGet($db, $secrets, "release/$rid", ['inc' => 'recordings+artist-credits+genres+release-groups']);
    $genres = [];
    foreach (array_merge((array)($r['genres'] ?? []), (array)($r['release-group']['genres'] ?? [])) as $g) {
        $nm = (string)($g['name'] ?? ''); if ($nm !== '') $genres[$nm] = max($genres[$nm] ?? 0, (int)($g['count'] ?? 0));
    }
    arsort($genres);
    $media = [];
    foreach ((array)($r['media'] ?? []) as $m) {
        $tr = [];
        foreach ((array)($m['tracks'] ?? []) as $t) {
            $tr[] = ['no' => (int)($t['position'] ?? 0), 'title' => (string)($t['title'] ?? ($t['recording']['title'] ?? '')),
                     'artist' => mbCredit($t['artist-credit'] ?? ($t['recording']['artist-credit'] ?? [])),
                     'ms' => isset($t['length']) ? (int)$t['length'] : (isset($t['recording']['length']) ? (int)$t['recording']['length'] : null),
                     'recording' => (string)($t['recording']['id'] ?? '')];
        }
        $media[] = ['disc' => (int)($m['position'] ?? count($media) + 1), 'format' => (string)($m['format'] ?? ''), 'tracks' => $tr];
    }
    $date = (string)($r['date'] ?? ($r['release-group']['first-release-date'] ?? ''));
    jsonOut(['ok' => true, 'release' => [
        'id' => (string)$r['id'], 'title' => (string)($r['title'] ?? ''), 'artist' => mbCredit($r['artist-credit'] ?? []),
        'date' => $date, 'year' => preg_match('/^(\d{4})/', $date, $mm) ? (int)$mm[1] : null,
        'firstYear' => preg_match('/^(\d{4})/', (string)($r['release-group']['first-release-date'] ?? ''), $m2) ? (int)$m2[1] : null,
        'genres' => array_slice(array_keys($genres), 0, 5), 'cover' => !empty($r['cover-art-archive']['front']),
        'coverThumb' => !empty($r['cover-art-archive']['front']) ? AUDIO_CAA_BASE . "/release/$rid/front-250" : null,
        'media' => $media,
    ]]);
}

// ---- covers you choose: from the Cover Art Archive, or a picture you upload ----
case 'cover_mb': {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'POST only');
    $ids = plIds($in['track_ids'] ?? null, 'track_ids');
    $rid = (string)($in['release'] ?? '');
    if (!$ids || !preg_match('/^[0-9a-f-]{36}$/', $rid)) fail(400, 'track_ids and a release id needed');
    [$code, $body] = httpGet(AUDIO_CAA_BASE . "/release/$rid/front-1200", mbUserAgent($secrets), 'image/*', 40);
    if ($code === 404) fail(404, 'the Cover Art Archive has no front cover for that release');
    if ($code !== 200 || $body === '') fail(502, $code ? "the Cover Art Archive answered $code" : 'couldn’t reach the Cover Art Archive');
    $name = storeCover($body);
    $db->beginTransaction();
    foreach ($ids as $id) trackEdit($db, $id, ['cover' => $name], 'musicbrainz');
    trackApply($db, $ids);
    $db->commit();
    jsonOut(['ok' => true, 'tracks' => shapeById($db, $ids)]);
}

case 'cover_upload': {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'POST only');
    $ids = plIds($in['track_ids'] ?? null, 'track_ids');
    $data = (string)($in['data'] ?? '');
    if (str_starts_with($data, 'data:')) $data = substr($data, (int)strpos($data, ',') + 1);
    $bytes = base64_decode($data, true);
    if (!$ids || $bytes === false || $bytes === '') fail(400, 'track_ids and a picture needed');
    $name = storeCover($bytes);
    $db->beginTransaction();
    foreach ($ids as $id) trackEdit($db, $id, ['cover' => $name], 'manual');
    trackApply($db, $ids);
    $db->commit();
    jsonOut(['ok' => true, 'tracks' => shapeById($db, $ids)]);
}

// ---- liked: the built-in playlist the hearts add to -----------------------
case 'liked': {
    $id = likedId($db);
    jsonOut(['ok' => true, 'id' => $id, 'ids' => likedIds($db, $id)]);
}

// track_ids[] + on: true likes them (newest first, each once); on: false takes them out.
case 'like': {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'POST only');
    $ids = plIds($in['track_ids'] ?? null, 'track_ids');
    $on = !array_key_exists('on', $in) || !empty($in['on']);
    $db->beginTransaction();
    $pl = likedId($db);
    $have = array_flip(likedIds($db, $pl));
    $n = 0;
    if ($on) {
        $live = plLiveTrackIds($db, $ids);
        $new = array_values(array_unique(array_filter($ids, static fn($t) => isset($live[$t]) && !isset($have[$t]))));
        if (count($have) + count($new) > PL_MAX_ITEMS) fail(400, 'Liked holds at most ' . number_format(PL_MAX_ITEMS) . ' tracks');
        if ($new) {
            run($db, 'UPDATE playlist_items SET pos = pos + :n WHERE playlist_id = :p', [':n' => count($new), ':p' => $pl]);
            $ins = $db->prepare('INSERT INTO playlist_items(playlist_id, pos, track_id, added_at) VALUES (:p, :o, :t, :a)');
            $now = gmdate('c'); $o = 0;
            foreach ($new as $t) $ins->execute([':p' => $pl, ':o' => ++$o, ':t' => $t, ':a' => $now]);
            $n = count($new);
        }
    } else {
        $del = $db->prepare('DELETE FROM playlist_items WHERE playlist_id = :p AND track_id = :t');
        foreach (array_unique($ids) as $t) { $del->execute([':p' => $pl, ':t' => $t]); $n += $del->rowCount(); }
        plRenumber($db, $pl, plItemIds($db, $pl));
    }
    if ($n) plTouch($db, $pl);
    $db->commit();
    jsonOut(['ok' => true, 'changed' => $n, 'id' => $pl, 'ids' => likedIds($db, $pl)]);
}

case 'playlist_create': {
    $name = plName($in);
    if (plNameTaken($db, $name)) fail(409, "you already have a playlist called “$name”");
    $ids = isset($in['track_ids']) ? plIds($in['track_ids'], 'track_ids') : [];
    $db->beginTransaction();
    run($db, 'INSERT INTO playlists(name, created_at, updated_at) VALUES (:n, :t, :t)', [':n' => $name, ':t' => gmdate('c')]);
    $id = (int)$db->lastInsertId();
    $added = $ids ? plAppend($db, $id, $ids) : 0;
    $db->commit();
    jsonOut(['ok' => true, 'id' => $id, 'name' => $name, 'added' => $added]);
}

case 'playlist_rename': {
    $id = plId($in); plNotLiked(plRow($db, $id));
    $name = plName($in);
    if (plNameTaken($db, $name, $id)) fail(409, "you already have a playlist called “$name”");
    run($db, 'UPDATE playlists SET name = :n, updated_at = :t WHERE id = :i', [':n' => $name, ':t' => gmdate('c'), ':i' => $id]);
    jsonOut(['ok' => true, 'name' => $name]);
}

case 'playlist_delete': {
    $id = plId($in); plNotLiked(plRow($db, $id));
    $db->beginTransaction();
    run($db, 'DELETE FROM playlist_items WHERE playlist_id = :i', [':i' => $id]);
    run($db, 'DELETE FROM playlists WHERE id = :i', [':i' => $id]);
    $db->commit();
    jsonOut(['ok' => true]);
}

case 'playlist_add': {
    $id = plId($in); $row = plRow($db, $id);
    $ids = plIds($in['track_ids'] ?? null, 'track_ids');
    if (($row['kind'] ?? null) === 'liked') {             // Liked holds each track once
        $have = array_flip(likedIds($db, $id));
        $ids = array_values(array_unique(array_filter($ids, static fn($t) => !isset($have[$t]))));
    }
    $db->beginTransaction();
    $added = plAppend($db, $id, $ids);
    $db->commit();
    jsonOut(['ok' => true, 'added' => $added, 'skipped' => count($ids) - $added]);
}

// entries[] are item ids from "playlist". missing:true drops every item whose track has left the library.
case 'playlist_remove': {
    $id = plId($in); plRow($db, $id);
    $db->beginTransaction();
    $gone = 0;
    if (!empty($in['missing'])) {
        $gone += run($db, 'DELETE FROM playlist_items WHERE playlist_id = :p AND track_id NOT IN (SELECT id FROM tracks WHERE deleted = 0)', [':p' => $id])->rowCount();
    }
    $entries = isset($in['entries']) ? plIds($in['entries'], 'entries') : [];
    foreach ($entries as $e) $gone += run($db, 'DELETE FROM playlist_items WHERE id = :e AND playlist_id = :p', [':e' => $e, ':p' => $id])->rowCount();
    plRenumber($db, $id, plItemIds($db, $id));
    plTouch($db, $id);
    $db->commit();
    jsonOut(['ok' => true, 'removed' => $gone]);
}

// Put one item before another (before: item id), or at the end (before: null/0).
case 'playlist_move': {
    $id = plId($in); plRow($db, $id);
    $entry = (int)($in['entry'] ?? 0);
    $before = (int)($in['before'] ?? 0);
    $order = plItemIds($db, $id);
    if (!in_array($entry, $order, true)) fail(404, 'no such entry in this playlist');
    if ($before !== 0 && !in_array($before, $order, true)) fail(404, 'no such entry to move before');
    if ($before === $entry) jsonOut(['ok' => true]);
    $order = array_values(array_filter($order, static fn($x) => $x !== $entry));
    $at = $before === 0 ? count($order) : (int)array_search($before, $order, true);
    array_splice($order, $at, 0, [$entry]);
    $db->beginTransaction();
    plRenumber($db, $id, $order);
    plTouch($db, $id);
    $db->commit();
    jsonOut(['ok' => true]);
}

// ---- scan_status / scan_request: the page's scan button ----------------
case 'scan_status':
    jsonOut(scanStatus($db));

case 'scan_request': {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'POST only');
    $st = scanStatus($db);
    if ($st['state'] === 'idle') {
        metaSet($db, 'scan_requested_at', gmdate('c'));
        $st = scanStatus($db);
    }
    jsonOut($st);
}

case 'audio_worker_start': {
    $now = gmdate('c');
    run($db, 'INSERT INTO scans(started_at, heartbeat, phase, complete) VALUES (:t, :t, :p, 0)', [':t' => $now, ':p' => 'starting']);
    metaSet($db, 'scan_requested_at', null);
    metaSet($db, 'scan_claimed_at', null);
    jsonOut(['ok' => true, 'scan_id' => (int)$db->lastInsertId()]);
}

// The gateway asks every 30 s whether the page wants a scan. Taking the
// request clears it, so one click starts one scan.
case 'audio_worker_poll': {
    metaSet($db, 'worker_seen_at', gmdate('c'));
    if (array_key_exists('can_write', $in)) metaSet($db, 'push_can_write', !empty($in['can_write']) ? '1' : '0');
    $want = metaGet($db, 'scan_requested_at') !== null;
    if ($want) {
        metaSet($db, 'scan_requested_at', null);
        metaSet($db, 'scan_claimed_at', gmdate('c'));
    }
    pushUnstick($db);
    jsonOut(['ok' => true, 'requested' => $want, 'push' => (int)run($db, "SELECT COUNT(*) FROM push_jobs WHERE state = 'queued'")->fetchColumn()]);
}

// The gateway takes the next few files to write. Each comes with a link to the cover to put in, if any.
case 'audio_worker_push_next': {
    pushUnstick($db);
    $db->beginTransaction();
    $jobs = run($db, "SELECT * FROM push_jobs WHERE state = 'queued' ORDER BY id LIMIT 10")->fetchAll();
    $out = [];
    foreach ($jobs as $j) {
        run($db, "UPDATE push_jobs SET state = 'working', started_at = :n WHERE id = :i", [':n' => gmdate('c'), ':i' => (int)$j['id']]);
        $cv = null;
        if ($j['cover']) {
            $e = time() + 3600;
            $cv = selfUrl() . '?action=art&f=' . rawurlencode((string)$j['cover']) . '&e=' . $e . '&s=' . artSig($secrets, (string)$j['cover'], $e);
        }
        $out[] = ['id' => (int)$j['id'], 'kind' => $j['kind'], 'path' => $j['path'], 'etag' => $j['etag'],
                  'changes' => json_decode((string)$j['changes'], true) ?: (object)[], 'cover_url' => $cv, 'drop_art' => (bool)$j['drop_art']];
    }
    $db->commit();
    jsonOut(['ok' => true, 'jobs' => $out]);
}

// How it went. Written: the file's tags are now these, so the edits that match go (the cover stays chosen).
// Undone: the file and the edits are back as they were before that write.
case 'audio_worker_push_done': {
    $id = (int)($in['id'] ?? 0);
    $j = run($db, "SELECT * FROM push_jobs WHERE id = :i AND state = 'working'", [':i' => $id])->fetch();
    if (!$j) fail(404, 'no such job in progress');
    $now = gmdate('c');
    $db->beginTransaction();
    if (empty($in['ok'])) {
        run($db, "UPDATE push_jobs SET state = 'failed', error = :e, finished_at = :n WHERE id = :i",
            [':e' => mb_substr((string)($in['error'] ?? 'failed'), 0, 500, 'UTF-8'), ':n' => $now, ':i' => $id]);
        $db->commit();
        jsonOut(['ok' => true]);
    }
    $tid = (int)$j['track_id'];
    $changes = json_decode((string)$j['changes'], true) ?: [];
    $row = run($db, 'SELECT file_tags FROM tracks WHERE id = :i', [':i' => $tid])->fetch();
    $file = json_decode((string)($row['file_tags'] ?? ''), true) ?: [];
    foreach ($changes as $f => $v) $file[$f] = isset(EDIT_INT[$f]) ? ($v === '' ? null : (int)$v) : (string)$v;
    $set = ['file_tags = :ft', 'updated_at = :n'];
    $p = [':ft' => json_encode($file, JSON_UNESCAPED_UNICODE), ':n' => $now, ':i' => $tid];
    if (isset($in['etag'])) { $set[] = 'etag = :e'; $p[':e'] = (string)$in['etag']; }
    if (isset($in['size'])) { $set[] = 'size = :s'; $p[':s'] = (int)$in['size']; }
    if ($j['kind'] === 'write') {
        if ($j['cover']) { $set[] = 'cover_pushed = :cp'; $p[':cp'] = $j['cover']; }
        run($db, 'UPDATE tracks SET ' . implode(', ', $set) . ' WHERE id = :i', $p);
        trackEdit($db, $tid, array_map('strval', $changes), 'manual');     // each now matches the file, so its edit goes
    } else {
        if (!empty($j['drop_art'])) $set[] = 'cover_pushed = NULL';
        run($db, 'UPDATE tracks SET ' . implode(', ', $set) . ' WHERE id = :i', $p);
        $before = json_decode((string)$j['before'], true) ?: [];
        run($db, 'DELETE FROM track_edits WHERE track_id = :t', [':t' => $tid]);
        $put = $db->prepare('INSERT INTO track_edits(track_id, field, value, source, edited_at) VALUES (:t, :f, :v, :s, :a)');
        foreach ((array)($before['edits'] ?? []) as $f => $v) $put->execute([':t' => $tid, ':f' => $f, ':v' => $v, ':s' => 'manual', ':a' => $now]);
    }
    run($db, "UPDATE push_jobs SET state = 'done', had_art = :h, finished_at = :n WHERE id = :i",
        [':h' => isset($in['had_art']) ? (int)!empty($in['had_art']) : null, ':n' => $now, ':i' => $id]);
    trackApply($db, [$tid]);
    $db->commit();
    jsonOut(['ok' => true]);
}

case 'audio_worker_progress': {
    $scan = (int)($in['scan_id'] ?? 0);
    if ($scan <= 0) fail(400, 'scan_id needed');
    run($db, 'UPDATE scans SET folders = :f, files_seen = :s, tagged = :t, errors = :e, phase = :p, heartbeat = :h
               WHERE id = :i AND finished_at IS NULL',
        [':f' => (int)($in['folders'] ?? 0), ':s' => (int)($in['files'] ?? 0), ':t' => (int)($in['tagged'] ?? 0),
         ':e' => (int)($in['errors'] ?? 0), ':p' => substr((string)($in['phase'] ?? 'scanning'), 0, 40),
         ':h' => gmdate('c'), ':i' => $scan]);
    jsonOut(['ok' => true]);
}

case 'audio_worker_seen': {
    $scan  = (int)($in['scan_id'] ?? 0);
    $files = $in['files'] ?? null;
    if ($scan <= 0 || !is_array($files)) fail(400, 'scan_id and files[] needed');
    $now = gmdate('c');
    $db->beginTransaction();
    $up = $db->prepare("INSERT INTO tracks(path, folder, filename, ext, size, etag, mtime, cover, search, scan_id, deleted, tagged, added_at, updated_at)
                        VALUES (:path, :folder, :fn, :ext, :size, :etag, :mtime, :cover, :search, :scan, 0, 0, :now, :now)
                        ON CONFLICT(path) DO UPDATE SET
                          size = excluded.size, mtime = excluded.mtime, cover = excluded.cover,
                          scan_id = excluded.scan_id, deleted = 0, updated_at = excluded.updated_at,
                          tagged = CASE WHEN tracks.etag IS excluded.etag AND tracks.size IS excluded.size THEN tracks.tagged ELSE 0 END,
                          etag = excluded.etag");
    $paths = [];
    foreach ($files as $f) {
        $path = cleanPath((string)($f['path'] ?? ''));
        if ($path === '') continue;
        $ext = strtolower((string)pathinfo($path, PATHINFO_EXTENSION));
        if (!isset(AUDIO_MIME[$ext])) continue;
        $dir = dirname($path);
        $up->execute([
            ':path' => $path, ':folder' => $dir === '.' ? '' : $dir, ':fn' => basename($path), ':ext' => $ext,
            ':size' => isset($f['size']) ? (int)$f['size'] : null, ':etag' => isset($f['etag']) ? (string)$f['etag'] : null,
            ':mtime' => isset($f['mtime']) ? (string)$f['mtime'] : null,
            ':cover' => ($c = cleanPath((string)($f['cover'] ?? ''))) === '' ? null : $c,
            ':search' => foldText($path),
            ':scan' => $scan, ':now' => $now,
        ]);
        $paths[] = $path;
    }
    $db->commit();
    $need = [];
    foreach (array_chunk($paths, 400) as $chunk) {
        $in2 = implode(',', array_fill(0, count($chunk), '?'));
        $st = $db->prepare("SELECT path FROM tracks WHERE tagged = 0 AND path IN ($in2)");
        $st->execute($chunk);
        foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $pth) $need[] = $pth;
    }
    jsonOut(['ok' => true, 'seen' => count($paths), 'need' => $need]);
}

case 'audio_worker_tags': {
    $list = $in['tracks'] ?? null;
    if (!is_array($list)) fail(400, 'tracks[] needed');
    $clip = static fn($v, int $n = 300): string => mb_substr(trim((string)$v), 0, $n, 'UTF-8');
    $int  = static fn($v): ?int => ($v === null || $v === '' || !is_numeric($v) || (int)$v <= 0) ? null : (int)$v;
    $now = gmdate('c');
    $db->beginTransaction();
    // The file's own tags go in file_tags; trackApply then puts your edits on top for what is shown.
    $st = $db->prepare("UPDATE tracks SET file_tags = :ft, duration_ms = :ms,
                          bitrate = :br, sample_rate = :sr, channels = :ch, codec = :codec, tag_error = :err,
                          tagged = 1, updated_at = :now WHERE path = :path");
    $idOf = $db->prepare('SELECT id FROM tracks WHERE path = :p');
    $n = 0; $ids = [];
    foreach ($list as $t) {
        $tpath = cleanPath((string)($t['path'] ?? ''));
        $ft = [
            'title' => $clip($t['title'] ?? ''), 'artist' => $clip($t['artist'] ?? ''), 'album_artist' => $clip($t['album_artist'] ?? ''),
            'album' => $clip($t['album'] ?? ''), 'track_no' => $int($t['track_no'] ?? null), 'disc_no' => $int($t['disc_no'] ?? null),
            'year' => $int($t['year'] ?? null), 'genre' => $clip($t['genre'] ?? '', 120),
        ];
        $st->execute([
            ':path' => $tpath, ':ft' => json_encode($ft, JSON_UNESCAPED_UNICODE),
            ':ms' => $int($t['duration_ms'] ?? null),
            ':br' => $int($t['bitrate'] ?? null), ':sr' => $int($t['sample_rate'] ?? null), ':ch' => $int($t['channels'] ?? null),
            ':codec' => $clip($t['codec'] ?? '', 40) ?: null,
            ':err' => ($e = $clip($t['error'] ?? '', 300)) === '' ? null : $e,
            ':now' => $now,
        ]);
        if ($st->rowCount()) { $n++; $idOf->execute([':p' => $tpath]); $ids[] = (int)$idOf->fetchColumn(); }
    }
    trackApply($db, $ids);
    $db->commit();
    jsonOut(['ok' => true, 'updated' => $n]);
}

case 'audio_worker_finish': {
    $scan     = (int)($in['scan_id'] ?? 0);
    $seen     = (int)($in['files_seen'] ?? 0);
    $complete = !empty($in['complete']);
    if ($scan <= 0) fail(400, 'scan_id needed');
    $pruned = 0; $skipped = null;
    if ($complete) {
        $live = (int)run($db, 'SELECT COUNT(*) FROM tracks WHERE deleted = 0')->fetchColumn();
        $gone = (int)run($db, 'SELECT COUNT(*) FROM tracks WHERE deleted = 0 AND scan_id IS NOT :s', [':s' => $scan])->fetchColumn();
        if ($seen <= 0) {
            $skipped = 'the walk saw no files - nothing was removed';
        } elseif ($live >= 100 && $gone * 2 > $live) {
            $skipped = "$gone of $live tracks were not seen - more than half, so nothing was removed (run again, or check the box)";
        } else {
            $pruned = run($db, 'UPDATE tracks SET deleted = 1, updated_at = :n WHERE deleted = 0 AND scan_id IS NOT :s',
                          [':n' => gmdate('c'), ':s' => $scan])->rowCount();
        }
    }
    $err  = substr(trim((string)($in['error'] ?? '')), 0, 300);
    $note = $err !== '' ? 'stopped: ' . $err : $skipped;
    run($db, 'UPDATE scans SET finished_at = :t, files_seen = :f, complete = :c, pruned = :p, phase = :ph, note = :n, heartbeat = :t WHERE id = :i',
        [':t' => gmdate('c'), ':f' => $seen, ':c' => $complete ? 1 : 0, ':p' => $pruned, ':ph' => $err !== '' ? 'failed' : 'done', ':n' => $note, ':i' => $scan]);
    jsonOut(['ok' => true, 'pruned' => $pruned, 'skipped_prune' => $skipped]);
}

default:
    fail(400, 'unknown action: ' . $action);
}
} catch (Throwable $e) {
    if ($db->inTransaction()) $db->rollBack();
    fail(500, $e->getMessage());
}
