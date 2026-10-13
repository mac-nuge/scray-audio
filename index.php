<?php
declare(strict_types=1);
// Scray audio :: the page. Same login as the rest of Scray (browse gate.php):
// no session, no page.
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
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0d0f12">
<title>Scray audio</title>
<link rel="stylesheet" href="audio.css?v=<?= $v('audio.css') ?>">
</head>
<body>
<header id="top">
  <a class="brand" href="#/">scray<b>audio</b></a>
  <nav id="tabs">
    <a href="#/" data-tab="folders">Folders</a>
    <a href="#/artists" data-tab="artists">Artists</a>
    <a href="#/albums" data-tab="albums">Albums</a>
    <a href="#/genres" data-tab="genres">Genres</a>
    <a href="#/playlists" data-tab="playlists">Playlists</a>
  </nav>
  <form id="searchform" role="search"><input id="search" type="search" placeholder="Search" autocomplete="off" enterkeyhint="search"></form>
  <button id="scanbtn" type="button" title="Library scan" aria-haspopup="dialog" aria-expanded="false"><span class="ic" aria-hidden="true">⟳</span><span id="scanlabel"></span></button>
  <button id="shuffleall" type="button" title="Shuffle the whole library">🔀 Shuffle all</button>
</header>

<section id="scanpanel" hidden role="dialog" aria-label="Library scan">
  <div class="shead"><b>Library scan</b><button id="scanclose" type="button" aria-label="Close">×</button></div>
  <div id="scanmsg" class="smsg"></div>
  <div id="scanbar" class="sbar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div>
  <dl id="scannums" class="snums"></dl>
  <div id="scanwarn" class="swarn" hidden></div>
  <div class="sbtns"><button id="scango" type="button" class="primary">Scan library now</button><button id="scanrefresh" type="button" hidden>Refresh this page’s list</button></div>
</section>

<main id="view" tabindex="-1"></main>

<section id="queuepanel" hidden aria-label="Queue">
  <div class="qhead"><b>Queue</b><span id="qcount"></span><button id="qclear" type="button">Clear</button><button id="qclose" type="button" aria-label="Close">×</button></div>
  <ol id="qlist"></ol>
</section>

<footer id="player">
  <div id="np">
    <div id="npcover" class="cover"><span>♪</span></div>
    <div id="nptext"><div id="nptitle">Nothing playing</div><div id="npsub"></div></div>
  </div>
  <div id="controls">
    <div class="row">
      <button id="bshuffle" type="button" title="Shuffle (S)" aria-pressed="false">🔀</button>
      <button id="bprev" type="button" title="Previous (P)">⏮</button>
      <button id="bplay" type="button" title="Play / pause (Space)">▶</button>
      <button id="bnext" type="button" title="Next (N)">⏭</button>
      <button id="brepeat" type="button" title="Repeat" aria-pressed="false">🔁</button>
    </div>
    <div class="row seek">
      <span id="tcur">0:00</span>
      <input id="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
      <span id="tdur">0:00</span>
    </div>
  </div>
  <div id="extras">
    <input id="vol" type="range" min="0" max="100" value="100" aria-label="Volume">
    <button id="bqueue" type="button" title="Queue">☰ <span id="qn"></span></button>
  </div>
</footer>
<div id="toast" role="status" aria-live="polite"></div>

<script src="/scray/scray-session.js"></script>
<script src="/scray/scray-version.js"></script>
<script src="audio.js?v=<?= $v('audio.js') ?>"></script>
</body>
</html>
