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
if ($action !== 'cover') {
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

const TRACK_COLS = 'id, title, artist, album_artist, album, track_no, disc_no, year, genre, duration_ms, ext, folder, filename, path, size, (cover IS NOT NULL) AS has_cover';

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

    $art = run($db, 'SELECT id FROM tracks WHERE deleted = 0 AND folder = :f AND cover IS NOT NULL LIMIT 1', [':f' => $path])->fetchColumn();
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
                             MIN(CASE WHEN cover IS NOT NULL THEN id END) art
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
                             MIN(CASE WHEN cover IS NOT NULL THEN id END) art
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
                         MIN(CASE WHEN cover IS NOT NULL THEN id END) art
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
    $c = run($db, 'SELECT cover FROM tracks WHERE id = :i AND deleted = 0 AND cover IS NOT NULL', [':i' => $id])->fetchColumn();
    if ($c === false || $c === null) fail(404, 'no cover');
    jsonOut(['ok' => true, 'url' => audioSignedUrl($secrets, (string)$c), 'expires_in' => max(60, audioTtl($secrets) - 300)]);
}

case 'cover': {
    $id = (int)($_GET['t'] ?? 0);
    $c = run($db, 'SELECT cover FROM tracks WHERE id = :i AND deleted = 0 AND cover IS NOT NULL', [':i' => $id])->fetchColumn();
    if ($c === false || $c === null) { http_response_code(404); header('Content-Type: text/plain'); echo 'no cover'; exit; }
    $keep = max(60, audioTtl($secrets) - 300);          // the redirect must not outlive the link it points at
    header('Cache-Control: private, max-age=' . $keep);
    header('Location: ' . audioSignedUrl($secrets, (string)$c), true, 302);
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
                               WHERE i2.playlist_id = p.id AND t2.deleted = 0 AND t2.cover IS NOT NULL
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
    $want = metaGet($db, 'scan_requested_at') !== null;
    if ($want) {
        metaSet($db, 'scan_requested_at', null);
        metaSet($db, 'scan_claimed_at', gmdate('c'));
    }
    jsonOut(['ok' => true, 'requested' => $want]);
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
    $st = $db->prepare("UPDATE tracks SET title = :title, artist = :artist, album_artist = :aa, album = :album,
                          track_no = :no, disc_no = :disc, year = :year, genre = :genre, duration_ms = :ms,
                          bitrate = :br, sample_rate = :sr, channels = :ch, codec = :codec, tag_error = :err,
                          search = :search, tagged = 1, updated_at = :now WHERE path = :path");
    $n = 0;
    foreach ($list as $t) {
        $artist = $clip($t['artist'] ?? '');
        $aa     = $clip($t['album_artist'] ?? '');
        if ($aa === '') $aa = $artist;
        if ($aa === '') $aa = 'Unknown artist';
        $tpath = cleanPath((string)($t['path'] ?? ''));
        $titleTag = $clip($t['title'] ?? '');
        $albumTag = $clip($t['album'] ?? '');
        $st->execute([
            ':path' => $tpath,
            ':search' => foldText(implode(' ', [$titleTag, $artist, $aa, $albumTag, $tpath])),
            ':title' => ($ti = $clip($t['title'] ?? '')) === '' ? null : $ti,
            ':artist' => $artist, ':aa' => $aa, ':album' => $clip($t['album'] ?? ''),
            ':no' => $int($t['track_no'] ?? null), ':disc' => $int($t['disc_no'] ?? null), ':year' => $int($t['year'] ?? null),
            ':genre' => $clip($t['genre'] ?? '', 120), ':ms' => $int($t['duration_ms'] ?? null),
            ':br' => $int($t['bitrate'] ?? null), ':sr' => $int($t['sample_rate'] ?? null), ':ch' => $int($t['channels'] ?? null),
            ':codec' => $clip($t['codec'] ?? '', 40) ?: null,
            ':err' => ($e = $clip($t['error'] ?? '', 300)) === '' ? null : $e,
            ':now' => $now,
        ]);
        $n += $st->rowCount();
    }
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
