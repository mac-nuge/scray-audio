<?php
// CI/test stand-in for Scray's real scray_secrets.php. Nothing here is secret.
return [
    'api_key'          => 'test-api-key',
    'hetzner_base'     => 'http://127.0.0.1:8099',
    'hetzner_secret'   => 'testsecret',
    'hetzner_ttl'      => 3600,
    'audio_worker_key' => 'test-worker-key',
    'audio_db'         => (getenv('SCRAY_AUDIO_TEST_DB') ?: sys_get_temp_dir() . '/scray-audio-test.sqlite'),
];
