<?php
declare(strict_types=1);
// Scray audio :: bulk MusicBrainz. Matches the whole library, album by album, on the server (the gateway drives it,
// or this tab when the gateway hasn't), and lists what it did and what it left for you. Desktop page; same login.
require_once __DIR__ . '/audio-config.php';
require_once AUDIO_AUTH_FILE;
if (!scray_logged_in()) {
    header('Location: ' . AUDIO_LOGIN_URL . '?next=' . urlencode($_SERVER['REQUEST_URI'] ?? '/'));
    exit;
}
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');
$v = static fn(string $f): string => (string)@filemtime(__DIR__ . '/' . $f);
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Bulk MusicBrainz · Scray audio</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{
  --ink:#0e141a; --panel:#151f29; --panel-2:#1b2733; --line:#26364a;
  --text:#c3d1dd; --dim:#6d8298; --amber:#f0a500; --cyan:#3ec7d4;
  --red:#e2574c; --green:#5bc98a; --violet:#8b7cf0;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0; background:var(--ink); color:var(--text); font-family:'Space Grotesk',system-ui,sans-serif; font-size:14px;
  display:flex; flex-direction:column}
button,input,select{font:inherit; color:inherit}
:focus-visible{outline:2px solid var(--cyan); outline-offset:1px}
a{color:var(--cyan)}
header{display:flex; align-items:center; gap:14px; flex-wrap:wrap; padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--line)}
.brand{display:flex; flex-direction:column; line-height:1.15}
.brand b{font-weight:700; letter-spacing:.14em; font-size:13px}
.brand span{color:var(--dim); font-size:11px; letter-spacing:.08em}
.navlink{color:var(--cyan); text-decoration:none; font-size:.75rem; border:1px solid var(--line); padding:5px 11px; border-radius:6px; white-space:nowrap}
.navlink:hover{border-color:var(--cyan)}
.mode{margin-left:auto; font-family:'JetBrains Mono',monospace; font-size:11px; letter-spacing:.1em; color:var(--amber)}
.mode.live{color:var(--cyan)}
.tiles{display:grid; grid-template-columns:repeat(auto-fit,minmax(118px,1fr)); gap:1px; background:var(--line); border-bottom:1px solid var(--line)}
.tile{background:var(--panel); padding:10px 14px; cursor:pointer}
.tile:hover{background:var(--panel-2)}
.tile b{display:block; font-family:'JetBrains Mono',monospace; font-size:19px; font-weight:500; color:var(--amber); line-height:1.2}
.tile span{font-size:10px; letter-spacing:.11em; color:var(--dim)}
.tile.good b{color:var(--green)} .tile.mark b{color:var(--violet)} .tile.bad b{color:var(--red)} .tile.soft b{color:var(--dim)}
.runner{padding:12px 16px; background:var(--panel-2); border-bottom:1px solid var(--line)}
.runrow{display:flex; align-items:center; gap:12px; flex-wrap:wrap}
.go{background:var(--amber); color:#1a1200; border:0; border-radius:3px; padding:7px 18px; font-weight:700; cursor:pointer; letter-spacing:.04em}
.go:hover:not(:disabled){filter:brightness(1.1)}
.go:disabled{opacity:.45; cursor:default}
.stop{background:transparent; color:var(--red); border:1px solid var(--red); border-radius:3px; padding:6px 14px; cursor:pointer}
.stop:disabled{opacity:.4; cursor:default}
.ghost{background:transparent; color:var(--dim); border:1px solid var(--line); border-radius:3px; padding:6px 12px; font-size:11px; letter-spacing:.06em; cursor:pointer}
.ghost:hover:not(:disabled){border-color:var(--cyan); color:var(--cyan)}
.ghost:disabled{opacity:.5; cursor:default}
.opt{display:flex; align-items:center; gap:5px; font-size:12px; color:var(--dim)}
.opt input[type=checkbox]{accent-color:var(--cyan)}
.opt select{background:var(--ink); border:1px solid var(--line); border-radius:3px; padding:4px 6px; font-size:12px}
.jobmeta{font-family:'JetBrains Mono',monospace; font-size:11.5px; color:var(--dim)}
.jobmeta .err{color:var(--red)} .jobmeta .ok{color:var(--green)}
.progress{margin-top:10px; height:10px; background:var(--ink); border:1px solid var(--line); border-radius:5px; overflow:hidden; display:none}
.progress.on{display:block}
.progress i{display:block; height:100%; width:0; background:linear-gradient(to right,var(--cyan),var(--amber)); transition:width .4s ease}
.etarow{display:none; margin-top:8px; gap:22px; flex-wrap:wrap; font-family:'JetBrains Mono',monospace; font-size:11.5px}
.etarow.on{display:flex}
.etarow div{display:flex; flex-direction:column; line-height:1.35; min-width:0}
.etarow b{font-weight:500; color:var(--cyan); font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:46vw}
.etarow span{font-size:9.5px; letter-spacing:.11em; color:var(--dim)}
.filterbar{display:flex; align-items:center; gap:8px; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel-2); flex-wrap:wrap}
.filterbar input.q{flex:1; min-width:200px; background:var(--ink); color:var(--text); border:1px solid var(--line); border-radius:3px; padding:7px 10px;
  font-family:'JetBrains Mono',monospace; font-size:12.5px; outline:none}
.filterbar input.q:focus{border-color:var(--cyan)}
.seg{display:flex; border:1px solid var(--line); border-radius:3px; overflow:hidden; flex-wrap:wrap}
.seg button{background:transparent; border:0; border-right:1px solid var(--line); color:var(--dim); padding:6px 11px; font-size:11px; letter-spacing:.06em; cursor:pointer}
.seg button:last-child{border-right:0}
.seg button:hover{color:var(--text)}
.seg button.on{background:var(--cyan); color:#04222a; font-weight:700}
.main{flex:1; min-height:0; display:flex}
.results{flex:1; overflow:auto; min-height:0}
table{border-collapse:collapse; width:100%; font-family:'JetBrains Mono',monospace; font-size:12px}
th{position:sticky; top:0; z-index:2; background:var(--panel); color:var(--cyan); text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); white-space:nowrap; font-weight:500}
td{padding:5px 10px; border-bottom:1px solid #1b2530; vertical-align:top; max-width:360px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
tr{cursor:pointer}
tr:hover td{background:var(--panel)}
tr.sel td{background:#132a35}
td.num{text-align:right; color:var(--amber)}
td.why{white-space:normal; color:var(--dim); min-width:240px}
td.why b{color:var(--text); font-weight:500}
.pill{display:inline-block; padding:1px 7px; border-radius:9px; font-size:10.5px; letter-spacing:.04em}
.pill.matched{background:rgba(91,201,138,.18); color:var(--green)}
.pill.review{background:rgba(240,165,0,.18); color:var(--amber)}
.pill.none{background:rgba(109,130,152,.18); color:var(--dim)}
.pill.error{background:rgba(226,87,76,.18); color:var(--red)}
.pill.skipped, .pill.undone{background:rgba(139,124,240,.18); color:var(--violet)}
.pill.pending{background:rgba(109,130,152,.12); color:#4d6076}
.pill.working{background:rgba(62,199,212,.16); color:var(--cyan)}
.empty{padding:40px 16px; text-align:center; color:var(--dim); line-height:1.6}
.more{display:block; margin:12px auto 20px}
/* the review drawer */
.drawer{width:min(520px,44vw); border-left:1px solid var(--line); background:var(--panel); overflow:auto; display:none; padding:14px 16px}
.drawer.on{display:block}
.drawer h2{margin:0 0 2px; font-size:16px}
.drawer .sub{color:var(--dim); font-size:12px; font-family:'JetBrains Mono',monospace; overflow-wrap:anywhere}
.drawer .why{margin:10px 0; padding:8px 10px; border-radius:4px; background:var(--panel-2); font-size:13px}
.drawer h3{margin:16px 0 6px; font-size:11px; letter-spacing:.11em; color:var(--dim); font-weight:500}
.cand{display:flex; align-items:center; gap:10px; padding:7px 8px; border:1px solid var(--line); border-radius:4px; margin-bottom:6px}
.cand .ct{flex:1; min-width:0}
.cand .ct b{display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.cand .ct span{display:block; font-size:12.5px}
.cand .ct i{display:block; font-style:normal; color:var(--dim); font-size:11.5px; font-family:'JetBrains Mono',monospace}
.cand.fit{border-left:3px solid var(--green)}
.srch{display:grid; grid-template-columns:1fr 1fr auto; gap:6px}
.srch input{background:var(--ink); border:1px solid var(--line); border-radius:3px; padding:6px 8px; font-size:12.5px; min-width:0}
.dbtns{display:flex; gap:8px; flex-wrap:wrap; margin-top:12px}
.x{float:right; background:none; border:0; color:var(--dim); font-size:20px; cursor:pointer}
.toast{position:fixed; left:50%; bottom:20px; transform:translateX(-50%); background:var(--panel-2); border:1px solid var(--line); padding:8px 14px;
  border-radius:4px; font-size:13px; opacity:0; transition:opacity .2s; pointer-events:none; z-index:20}
.toast.on{opacity:1} .toast.bad{border-color:var(--red); color:var(--red)}
</style>
</head>
<body>
<header>
  <div class="brand"><b>BULK MUSICBRAINZ</b><span>match · fix · covers</span></div>
  <a class="navlink" href="index.php">‹ Library</a>
  <span class="mode" id="mode">—</span>
</header>

<div class="tiles" id="tiles"></div>

<div class="runner">
  <div class="runrow">
    <button class="go" id="startBtn" type="button">Start</button>
    <button class="ghost" id="pauseBtn" type="button" disabled>Pause</button>
    <button class="stop" id="stopBtn" type="button" disabled>Stop</button>
    <label class="opt">take <select id="optMode">
      <option value="oldest">the original release (oldest)</option>
      <option value="best">the best match</option>
    </select></label>
    <label class="opt" title="Albums set aside before (to review, not found, errors) are tried again"><input type="checkbox" id="optRetry"> try the set-aside ones again</label>
    <label class="opt" title="Albums already matched are matched again (undone ones too)"><input type="checkbox" id="optRedo"> redo matched albums</label>
    <label class="opt" title="Each matched album is also queued to be written into the files by the gateway (needs SCRAY_WRITE_TAGS=1 there)"><input type="checkbox" id="optWrite"> also write into the files</label>
    <span class="jobmeta" id="meta">loading…</span>
  </div>
  <div class="progress" id="progress"><i id="fill"></i></div>
  <div class="etarow" id="eta"></div>
</div>

<div class="filterbar">
  <div class="seg" id="seg">
    <button data-v="all" class="on">ALL</button>
    <button data-v="matched">MATCHED</button>
    <button data-v="review">TO REVIEW</button>
    <button data-v="none">NOT FOUND</button>
    <button data-v="skipped">SKIPPED</button>
    <button data-v="error">ERRORS</button>
    <button data-v="pending">WAITING</button>
    <button data-v="undone">UNDONE</button>
  </div>
  <input class="q" id="filter" type="search" spellcheck="false" autocomplete="off" placeholder="Filter: album, artist, folder, release">
  <span class="jobmeta" id="rowMeta"></span>
</div>

<div class="main">
  <div class="results" id="results"><div class="empty">Start a run: every album is looked up on MusicBrainz, one at a time.<br>
    It runs on the server, so you can close this tab and come back.</div></div>
  <aside class="drawer" id="drawer"></aside>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>

<script src="bulk-mb.js?v=<?= $v('bulk-mb.js') ?>"></script>
</body>
</html>
