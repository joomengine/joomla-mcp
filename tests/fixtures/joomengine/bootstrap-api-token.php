<?php

declare(strict_types=1);

/**
 * Disposable-fixture bootstrap only.
 *
 * Creates a fresh Joomla API token seed for the fixture administrator and
 * prints the derived token once to stdout. The shell fixture captures stdout
 * in a mode-0600 file and never includes it in uploaded evidence.
 */

const JOOMLA_FIXTURE_ROOT = '/var/www/html';

$configurationFile = JOOMLA_FIXTURE_ROOT . '/configuration.php';

if (!is_file($configurationFile)) {
    fwrite(STDERR, "Joomla configuration.php is unavailable.\n");
    exit(1);
}

require_once $configurationFile;

$configuration = new JConfig();
$prefix = (string) $configuration->dbprefix;

if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
    fwrite(STDERR, "Joomla returned an invalid database prefix.\n");
    exit(1);
}

$databaseHost = (string) $configuration->host;
$databasePort = property_exists($configuration, 'port') && (int) $configuration->port > 0
    ? (int) $configuration->port
    : 3306;

if (preg_match('/^([^:]+):([0-9]+)$/', $databaseHost, $hostParts) === 1) {
    $databaseHost = $hostParts[1];
    $databasePort = (int) $hostParts[2];
}

$dsn = sprintf(
    'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
    $databaseHost,
    $databasePort,
    (string) $configuration->db,
);
$database = new PDO(
    $dsn,
    (string) $configuration->user,
    (string) $configuration->password,
    [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_EMULATE_PREPARES => false,
    ],
);

$userQuery = $database->prepare(
    sprintf('SELECT id FROM `%susers` WHERE username = :username LIMIT 1', $prefix),
);
$userQuery->execute(['username' => 'mcpfixture']);
$userId = (int) $userQuery->fetchColumn();

if ($userId < 1) {
    fwrite(STDERR, "The fixture administrator account does not exist.\n");
    exit(1);
}

$seed = random_bytes(32);
$encodedSeed = base64_encode($seed);
$delete = $database->prepare(
    sprintf(
        'DELETE FROM `%suser_profiles` WHERE user_id = :user_id AND profile_key IN (:token_key, :enabled_key)',
        $prefix,
    ),
);
$delete->execute([
    'user_id' => $userId,
    'token_key' => 'joomlatoken.token',
    'enabled_key' => 'joomlatoken.enabled',
]);
$insert = $database->prepare(
    sprintf(
        'INSERT INTO `%suser_profiles` (user_id, profile_key, profile_value, ordering) VALUES (:user_id, :profile_key, :profile_value, :ordering)',
        $prefix,
    ),
);
$insert->execute([
    'user_id' => $userId,
    'profile_key' => 'joomlatoken.token',
    'profile_value' => $encodedSeed,
    'ordering' => 1,
]);
$insert->execute([
    'user_id' => $userId,
    'profile_key' => 'joomlatoken.enabled',
    'profile_value' => '1',
    'ordering' => 2,
]);

$enable = $database->prepare(
    sprintf(
        "UPDATE `%sextensions` SET enabled = 1 WHERE type = 'plugin' AND element = 'token' AND folder IN ('api-authentication', 'user')",
        $prefix,
    ),
);
$enable->execute();

$companionQuery = $database->query(
    sprintf(
        "SELECT extension_id, params FROM `%sextensions` WHERE type = 'plugin' AND folder = 'console' AND element = 'joomlamcp' LIMIT 1",
        $prefix,
    ),
);
$companion = $companionQuery->fetch(PDO::FETCH_ASSOC);

if (!is_array($companion) || (int) ($companion['extension_id'] ?? 0) < 1) {
    fwrite(STDERR, "The Joomla MCP companion plugin is not installed.\n");
    exit(1);
}

$companionParams = json_decode((string) ($companion['params'] ?? '{}'), true);
$companionParams = is_array($companionParams) ? $companionParams : [];
$companionParams['actor_user_id'] = $userId;
$configureCompanion = $database->prepare(
    sprintf('UPDATE `%sextensions` SET enabled = 1, params = :params WHERE extension_id = :extension_id', $prefix),
);
$configureCompanion->execute([
    'params' => json_encode($companionParams, JSON_THROW_ON_ERROR),
    'extension_id' => (int) $companion['extension_id'],
]);

$hash = hash_hmac('sha256', $seed, (string) $configuration->secret);
$token = base64_encode(sprintf('sha256:%d:%s', $userId, $hash));

fwrite(STDOUT, $token);
