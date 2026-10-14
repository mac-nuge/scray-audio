<?php
declare(strict_types=1);

/**
 * Scray audio :: where things live.
 *
 * Secrets and the database sit outside the web root, beside Scray's own, so
 * this file holds no secret and is safe to commit. It is included by api.php
 * and index.php only; the .htaccess blocks a direct request for it.
 *
 * SCRAY_AUDIO_DATA_DIR is for tests and CI, which point it at tests/stub-data.
 * On the server it is never set.
 */
$__d = getenv('SCRAY_AUDIO_DATA_DIR');
$__dir = ($__d !== false && $__d !== '') ? rtrim($__d, '/') : '/home/u990405754/domains/macnguyen.com/scray-data';

// scray_auth.php was written for Scray's own pages and may read these two.
if (!defined('SCRAY_DATA_DIR'))     define('SCRAY_DATA_DIR', $__dir);
if (!defined('SCRAY_SECRETS_FILE')) define('SCRAY_SECRETS_FILE', $__dir . '/scray_secrets.php');

const AUDIO_LOGIN_URL = '/scray/login.php';
define('AUDIO_AUTH_FILE', $__dir . '/scray_auth.php');
define('AUDIO_DB_FILE',   $__dir . '/audio.sqlite');
// Covers you chose (MusicBrainz / upload), kept beside the database. Tests point it elsewhere.
$__c = getenv('SCRAY_AUDIO_COVERS_DIR');
define('AUDIO_COVERS_DIR', ($__c !== false && $__c !== '') ? rtrim($__c, '/') : $__dir . '/audio-covers');
// MusicBrainz and the Cover Art Archive. Tests point these at a stand-in.
$__m = getenv('SCRAY_AUDIO_MB_BASE');
define('AUDIO_MB_BASE', ($__m !== false && $__m !== '') ? rtrim($__m, '/') : 'https://musicbrainz.org/ws/2');
$__a = getenv('SCRAY_AUDIO_CAA_BASE');
define('AUDIO_CAA_BASE', ($__a !== false && $__a !== '') ? rtrim($__a, '/') : 'https://coverartarchive.org');
unset($__d, $__dir);
