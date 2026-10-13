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
    if (!in_array($tier, ['session', 'admin'], true)) fail(401, 'bad key - log in again');
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

const TRACK_COLS = 'id, title, artist, album_artist, album, track_no, disc_no, year, genre, duration_ms, ext, folder, filename, (cover IS NOT NULL) AS has_cover';

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
    $in = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($in)) fail(400, 'body is not JSON');
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
    if (isset($_GET['album']) && isset($_GET['artist'])) $rows = sortTracks($rows);
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
    if ($q === '') jsonOut(['ok' => true, 'tracks' => [], 'artists' => [], 'albums' => []]);
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
        ], array_slice($albums, 0, 40))]);
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

case 'audio_worker_start': {
    run($db, 'INSERT INTO scans(started_at, complete) VALUES (:t, 0)', [':t' => gmdate('c')]);
    jsonOut(['ok' => true, 'scan_id' => (int)$db->lastInsertId()]);
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
    run($db, 'UPDATE scans SET finished_at = :t, files_seen = :f, complete = :c, pruned = :p WHERE id = :i',
        [':t' => gmdate('c'), ':f' => $seen, ':c' => $complete ? 1 : 0, ':p' => $pruned, ':i' => $scan]);
    jsonOut(['ok' => true, 'pruned' => $pruned, 'skipped_prune' => $skipped]);
}

default:
    fail(400, 'unknown action: ' . $action);
}
} catch (Throwable $e) {
    if ($db->inTransaction()) $db->rollBack();
    fail(500, $e->getMessage());
}
