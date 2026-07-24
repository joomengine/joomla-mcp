<?php

declare(strict_types=1);

/**
 * Disposable-fixture bootstrap only.
 *
 * Creates fresh API and Joomla Update tokens plus deterministic records/files
 * required by the complete live catalogue. The shell fixture captures the
 * JSON secret result in a mode-0600 file and never uploads it.
 */

const JOOMLA_FIXTURE_ROOT = '/var/www/html';
const JOOMLA_FIXTURE_UPDATE_VERSION = '6.1.99';
const JOOMLA_FIXTURE_PRIVACY_EMAIL = 'fixture@example.invalid';
const JOOMLA_FIXTURE_PRIVACY_CONSENT_SUBJECT = 'Joomla MCP live prerequisite consent';

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
    sprintf('SELECT id, email FROM `%susers` WHERE username = :username LIMIT 1', $prefix),
);
$userQuery->execute(['username' => 'mcpfixture']);
$fixtureUser = $userQuery->fetch(PDO::FETCH_ASSOC);
$userId = (int) ($fixtureUser['id'] ?? 0);

if ($userId < 1) {
    fwrite(STDERR, "The fixture administrator account does not exist.\n");
    exit(1);
}
if ((string) ($fixtureUser['email'] ?? '') !== JOOMLA_FIXTURE_PRIVACY_EMAIL) {
    fwrite(STDERR, "The fixture administrator email does not match the live-test prerequisite.\n");
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

$mediaDirectory = JOOMLA_FIXTURE_ROOT . '/images';
$mediaPath = $mediaDirectory . '/joomla-mcp-live-prerequisite.png';
if (!is_dir($mediaDirectory) && !mkdir($mediaDirectory, 0775, true) && !is_dir($mediaDirectory)) {
    fwrite(STDERR, "Unable to create the fixture media directory.\n");
    exit(1);
}
$mediaBytes = base64_decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    true,
);
if ($mediaBytes === false || file_put_contents($mediaPath, $mediaBytes, LOCK_EX) === false) {
    fwrite(STDERR, "Unable to write the fixture media prerequisite.\n");
    exit(1);
}

$overrideFixtures = [
    JOOMLA_FIXTURE_ROOT . '/administrator/language/overrides/en-GB.override.ini' => [
        'JOOMLA_MCP_LIVE_PREREQUISITE_ADMINISTRATOR',
        'Joomla MCP live prerequisite administrator',
    ],
    JOOMLA_FIXTURE_ROOT . '/language/overrides/en-GB.override.ini' => [
        'JOOMLA_MCP_LIVE_PREREQUISITE_SITE',
        'Joomla MCP live prerequisite site',
    ],
];
foreach ($overrideFixtures as $path => [$constant, $value]) {
    $directory = dirname($path);
    if (!is_dir($directory) && !mkdir($directory, 0775, true) && !is_dir($directory)) {
        fwrite(STDERR, sprintf("Unable to create language override directory %s.\n", $directory));
        exit(1);
    }
    $line = sprintf('%s="%s"%s', $constant, addcslashes($value, '"\\'), PHP_EOL);
    if (file_put_contents($path, $line, LOCK_EX) === false) {
        fwrite(STDERR, sprintf("Unable to write language override fixture %s.\n", $path));
        exit(1);
    }
}

$deletePrivacyRequest = $database->prepare(
    sprintf('DELETE FROM `%sprivacy_requests` WHERE email = :email', $prefix),
);
$deletePrivacyRequest->execute(['email' => JOOMLA_FIXTURE_PRIVACY_EMAIL]);
$insertPrivacyRequest = $database->prepare(
    sprintf(
        'INSERT INTO `%sprivacy_requests` '
        . '(email, requested_at, status, request_type, confirm_token, confirm_token_created_at) '
        . "VALUES (:email, UTC_TIMESTAMP(), 1, 'export', '', NULL)",
        $prefix,
    ),
);
$insertPrivacyRequest->execute(['email' => JOOMLA_FIXTURE_PRIVACY_EMAIL]);

$deletePrivacyConsent = $database->prepare(
    sprintf('DELETE FROM `%sprivacy_consents` WHERE subject = :subject', $prefix),
);
$deletePrivacyConsent->execute(['subject' => JOOMLA_FIXTURE_PRIVACY_CONSENT_SUBJECT]);
$insertPrivacyConsent = $database->prepare(
    sprintf(
        'INSERT INTO `%sprivacy_consents` '
        . '(user_id, state, created, subject, body, remind, token) '
        . 'VALUES (:user_id, 1, UTC_TIMESTAMP(), :subject, :body, 0, :token)',
        $prefix,
    ),
);
$insertPrivacyConsent->execute([
    'user_id' => $userId,
    'subject' => JOOMLA_FIXTURE_PRIVACY_CONSENT_SUBJECT,
    'body' => 'Deterministic consent record for Joomla MCP live read verification.',
    'token' => hash('sha256', 'joomla-mcp-live-prerequisite-consent'),
]);

$updateDirectory = JOOMLA_FIXTURE_ROOT . '/joomla-mcp-fixture-update';
if (!is_dir($updateDirectory) && !mkdir($updateDirectory, 0775, true) && !is_dir($updateDirectory)) {
    fwrite(STDERR, "Unable to create the fixture update directory.\n");
    exit(1);
}
if (!class_exists(ZipArchive::class)) {
    fwrite(STDERR, "The fixture PHP runtime does not provide ZipArchive.\n");
    exit(1);
}
$updateFileName = sprintf(
    'Joomla_%s-Stable-Update_Package.zip',
    JOOMLA_FIXTURE_UPDATE_VERSION,
);
$updatePackage = $updateDirectory . '/' . $updateFileName;
$zip = new ZipArchive();
if ($zip->open($updatePackage, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
    fwrite(STDERR, "Unable to create the fixture Joomla Update package.\n");
    exit(1);
}
$zip->addFromString(
    'joomla-mcp-fixture-update.txt',
    "Deterministic package used only to exercise Joomla Update prepare/finalize.\n",
);
if (!$zip->close()) {
    fwrite(STDERR, "Unable to finalize the fixture Joomla Update package.\n");
    exit(1);
}
$updateUrl = sprintf(
    'http://127.0.0.1/joomla-mcp-fixture-update/%s',
    $updateFileName,
);
$updateManifest = sprintf(
    <<<'XML'
<?xml version="1.0" encoding="utf-8"?>
<updates>
  <update>
    <name>Joomla MCP deterministic fixture update</name>
    <description>Local disposable-fixture package for endpoint validation.</description>
    <element>joomla</element>
    <type>file</type>
    <version>%s</version>
    <downloads>
      <downloadurl type="full" format="zip">%s</downloadurl>
    </downloads>
    <tags><tag>stable</tag></tags>
    <supported_databases>
      <database type="mysql" minimum="8.0.13" />
      <database type="mariadb" minimum="10.4.0" />
    </supported_databases>
    <php_minimum>8.3.0</php_minimum>
    <sha256>%s</sha256>
    <sha384>%s</sha384>
    <sha512>%s</sha512>
    <maintainer>Joomla MCP live fixture</maintainer>
    <section>STS</section>
    <targetplatform name="joomla" version="6.1" />
  </update>
</updates>
XML,
    JOOMLA_FIXTURE_UPDATE_VERSION,
    htmlspecialchars($updateUrl, ENT_XML1 | ENT_QUOTES, 'UTF-8'),
    hash_file('sha256', $updatePackage),
    hash_file('sha384', $updatePackage),
    hash_file('sha512', $updatePackage),
);
if (file_put_contents($updateDirectory . '/core-update.xml', $updateManifest, LOCK_EX) === false) {
    fwrite(STDERR, "Unable to write the fixture Joomla Update manifest.\n");
    exit(1);
}

$coreUpdateSiteQuery = $database->query(
    sprintf(
        "SELECT usex.update_site_id "
        . "FROM `%supdate_sites_extensions` AS usex "
        . "INNER JOIN `%sextensions` AS extension ON extension.extension_id = usex.extension_id "
        . "WHERE extension.type = 'file' AND extension.element = 'joomla' LIMIT 1",
        $prefix,
        $prefix,
    ),
);
$coreUpdateSiteId = (int) $coreUpdateSiteQuery->fetchColumn();
if ($coreUpdateSiteId < 1) {
    fwrite(STDERR, "Unable to locate Joomla's core update site.\n");
    exit(1);
}
$configureUpdateSite = $database->prepare(
    sprintf(
        "UPDATE `%supdate_sites` SET name = :name, type = 'extension', location = :location, "
        . 'enabled = 1, last_check_timestamp = 0, extra_query = :extra_query '
        . 'WHERE update_site_id = :update_site_id',
        $prefix,
    ),
);
$configureUpdateSite->execute([
    'name' => 'Joomla MCP deterministic fixture update',
    'location' => 'http://127.0.0.1/joomla-mcp-fixture-update/core-update.xml',
    'extra_query' => '',
    'update_site_id' => $coreUpdateSiteId,
]);
$clearCachedCoreUpdate = $database->prepare(
    sprintf("DELETE FROM `%supdates` WHERE element = 'joomla'", $prefix),
);
$clearCachedCoreUpdate->execute();

$updateToken = bin2hex(random_bytes(32));
$joomlaUpdateQuery = $database->query(
    sprintf(
        "SELECT extension_id, params FROM `%sextensions` "
        . "WHERE type = 'component' AND element = 'com_joomlaupdate' LIMIT 1",
        $prefix,
    ),
);
$joomlaUpdate = $joomlaUpdateQuery->fetch(PDO::FETCH_ASSOC);
if (!is_array($joomlaUpdate) || (int) ($joomlaUpdate['extension_id'] ?? 0) < 1) {
    fwrite(STDERR, "The Joomla Update component is unavailable.\n");
    exit(1);
}
$joomlaUpdateParams = json_decode((string) ($joomlaUpdate['params'] ?? '{}'), true);
$joomlaUpdateParams = is_array($joomlaUpdateParams) ? $joomlaUpdateParams : [];
$joomlaUpdateParams['updatesource'] = 'default';
$joomlaUpdateParams['minimum_stability'] = 4;
$joomlaUpdateParams['autoupdate'] = 1;
$joomlaUpdateParams['update_token'] = $updateToken;
$configureJoomlaUpdate = $database->prepare(
    sprintf('UPDATE `%sextensions` SET params = :params WHERE extension_id = :extension_id', $prefix),
);
$configureJoomlaUpdate->execute([
    'params' => json_encode($joomlaUpdateParams, JSON_THROW_ON_ERROR),
    'extension_id' => (int) $joomlaUpdate['extension_id'],
]);
$enableJoomlaUpdateWebservice = $database->prepare(
    sprintf(
        "UPDATE `%sextensions` SET enabled = 1 "
        . "WHERE type = 'plugin' AND folder = 'webservices' AND element = 'joomlaupdate'",
        $prefix,
    ),
);
$enableJoomlaUpdateWebservice->execute();

$hash = hash_hmac('sha256', $seed, (string) $configuration->secret);
$token = base64_encode(sprintf('sha256:%d:%s', $userId, $hash));

fwrite(
    STDOUT,
    json_encode(
        ['apiToken' => $token, 'updateToken' => $updateToken],
        JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES,
    ),
);
