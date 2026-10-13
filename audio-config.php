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
unset($__d, $__dir);
