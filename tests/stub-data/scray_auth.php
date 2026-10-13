<?php
// CI/test stand-in for Scray's real scray_auth.php: a cookie is a session,
// the key "test-admin" is the console key, anything else gets nothing.
function scray_logged_in(): bool { return ($_COOKIE['scray_test_session'] ?? '') === '1'; }
function scray_auth_tier(string $key): string {
    if ($key === 'test-admin') return 'admin';
    return scray_logged_in() ? 'session' : 'none';
}
