#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIRECTORY
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIRECTORY}/../.." && pwd -P)"
readonly REPOSITORY_ROOT
COMPOSE_FILE="${REPOSITORY_ROOT}/tests/fixtures/joomengine/compose.yaml"
readonly COMPOSE_FILE
CORE_CLI_COMMANDS_FILE="${REPOSITORY_ROOT}/tests/fixtures/joomengine/core-cli-commands.txt"
readonly CORE_CLI_COMMANDS_FILE
JOOMLA_FIXTURE_API_BOOTSTRAP="${REPOSITORY_ROOT}/tests/fixtures/joomengine/bootstrap-api-token.php"
export JOOMLA_FIXTURE_API_BOOTSTRAP

fail() {
  printf 'JoomEngine fixture failed: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

require_command docker
require_command node
require_command openssl
require_command sha256sum
require_command timeout
require_command realpath
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required.'

companion_zip="${JOOMLA_FIXTURE_COMPANION_ZIP:-}"

if [[ -z "$companion_zip" ]]; then
  mapfile -t package_candidates < <(
    find "${REPOSITORY_ROOT}/companion/dist" -maxdepth 1 -type f -name 'pkg_joomlamcp-*.zip' -print 2>/dev/null | sort
  )
  [[ "${#package_candidates[@]}" -eq 1 ]] \
    || fail 'expected exactly one companion/dist/pkg_joomlamcp-*.zip package'
  companion_zip="${package_candidates[0]}"
fi

[[ -f "$companion_zip" && -r "$companion_zip" ]] || fail "companion package is not readable: $companion_zip"
companion_zip="$(realpath -- "$companion_zip")"
export JOOMLA_FIXTURE_COMPANION_ZIP="$companion_zip"

JOOMLA_FIXTURE_IMAGE="${JOOMLA_FIXTURE_IMAGE:-octoleo/joomengine:6@sha256:5fbcccb6275cc8336d22cad563082e09824bd04e0035bc1837787be8f16b2372}"
JOOMLA_FIXTURE_DATABASE_IMAGE="${JOOMLA_FIXTURE_DATABASE_IMAGE:-mariadb:11.4@sha256:a794d9eb009e20de605858a11f32f63b4075cbd197c650436f0e3b457e4caed7}"
JOOMLA_FIXTURE_DATABASE_NAME="${JOOMLA_FIXTURE_DATABASE_NAME:-joomlamcp}"
JOOMLA_FIXTURE_DATABASE_USER="${JOOMLA_FIXTURE_DATABASE_USER:-joomlamcp}"
JOOMLA_FIXTURE_DATABASE_PASSWORD="${JOOMLA_FIXTURE_DATABASE_PASSWORD:-$(openssl rand -hex 24)}"
JOOMLA_FIXTURE_DATABASE_ROOT_PASSWORD="${JOOMLA_FIXTURE_DATABASE_ROOT_PASSWORD:-$(openssl rand -hex 24)}"
JOOMLA_FIXTURE_ADMIN_PASSWORD="${JOOMLA_FIXTURE_ADMIN_PASSWORD:-$(openssl rand -hex 24)}"
export JOOMLA_FIXTURE_ADMIN_PASSWORD JOOMLA_FIXTURE_DATABASE_IMAGE
export JOOMLA_FIXTURE_DATABASE_NAME JOOMLA_FIXTURE_DATABASE_PASSWORD
export JOOMLA_FIXTURE_DATABASE_ROOT_PASSWORD JOOMLA_FIXTURE_DATABASE_USER
export JOOMLA_FIXTURE_IMAGE

artifact_directory="${JOOMLA_FIXTURE_ARTIFACT_DIR:-${TMPDIR:-/tmp}/joomla-mcp-joomengine-evidence}"
mkdir -p -- "$artifact_directory"
chmod 0700 -- "$artifact_directory"
artifact_directory="$(realpath -- "$artifact_directory")"
readonly artifact_directory

raw_project_name="joomla-mcp-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
project_name="$(printf '%s' "$raw_project_name" | tr -cs '[:alnum:]_-' '-' | cut -c1-58)"
readonly project_name
compose=(docker compose --project-name "$project_name" --file "$COMPOSE_FILE")

collect_diagnostics() {
  "${compose[@]}" ps --all >"${artifact_directory}/compose-ps.txt" 2>&1 || true
  "${compose[@]}" logs --no-color --timestamps >"${artifact_directory}/compose.log" 2>&1 || true
  local diagnostics_container
  diagnostics_container="$("${compose[@]}" ps --quiet joomla 2>/dev/null || true)"
  if [[ -n "$diagnostics_container" ]]; then
    mkdir -p -- "${artifact_directory}/joomla-logs"
    docker cp "${diagnostics_container}:/var/www/html/administrator/logs/." \
      "${artifact_directory}/joomla-logs/" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  local status="$1"
  trap - EXIT
  set +e
  rm -f -- "${artifact_directory}/.api-token"
  collect_diagnostics

  if [[ "${JOOMLA_FIXTURE_KEEP:-0}" != '1' ]]; then
    "${compose[@]}" down --volumes --remove-orphans --timeout 15 >/dev/null 2>&1 || true
  else
    printf 'Fixture retained with Compose project name %s.\n' "$project_name" >&2
  fi

  if ((status != 0)); then
    printf 'Fixture diagnostics: %s\n' "$artifact_directory" >&2
  fi

  exit "$status"
}
trap 'cleanup "$?"' EXIT

package_sha256="$(sha256sum -- "$companion_zip" | cut -d ' ' -f1)"
readonly package_sha256

"${compose[@]}" config --quiet
"${compose[@]}" pull --quiet
"${compose[@]}" up --detach --wait --wait-timeout 360

joomla_container_id="$("${compose[@]}" ps --quiet joomla)"
[[ -n "$joomla_container_id" ]] || fail 'the Joomla container was not created'
[[ "$(docker inspect --format '{{.State.Status}}' "$joomla_container_id")" == 'running' ]] \
  || fail 'the Joomla container is not running after bootstrap'

fixture_origin='http://127.0.0.1'
readonly fixture_origin
"${compose[@]}" exec --no-TTY --user www-data joomla \
  curl --fail --silent --show-error --max-time 15 "${fixture_origin}/" \
  >"${artifact_directory}/site.html"

"${compose[@]}" exec --no-TTY --user www-data --workdir /var/www/html joomla \
  php cli/joomla.php joomla:mcp:describe --format=json --no-interaction --no-ansi \
  >"${artifact_directory}/describe.json"

"${compose[@]}" exec --no-TTY --user www-data --workdir /var/www/html joomla \
  php cli/joomla.php joomla:mcp:self-test --format=json --no-interaction --no-ansi \
  >"${artifact_directory}/self-test.json"

"${compose[@]}" exec --no-TTY --user www-data --workdir /var/www/html joomla \
  php cli/joomla.php joomla:mcp:cli-inventory --format=json --no-interaction --no-ansi \
  >"${artifact_directory}/cli-inventory.json"

"${compose[@]}" exec --no-TTY --user www-data --workdir /var/www/html joomla \
  php cli/joomla.php list --no-interaction --no-ansi \
  >"${artifact_directory}/cli-list.txt"

# Help is Joomla's native, side-effect-free documentation path. Exercise it
# for every installed command without executing the target command itself.
cli_help_directory="${artifact_directory}/cli-help"
mkdir -p -- "$cli_help_directory"
installed_cli_commands_file="${artifact_directory}/installed-cli-commands.txt"
node --input-type=module - "${artifact_directory}/cli-inventory.json" >"$installed_cli_commands_file" <<'NODE'
import { readFileSync } from 'node:fs';

const inventory = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const commands = Array.isArray(inventory.commands)
  ? inventory.commands.map((command) => command?.name)
  : [];

if (commands.some((command) => typeof command !== 'string')) {
  throw new Error('The Joomla CLI inventory contains an invalid command name.');
}

process.stdout.write(`${[...new Set(commands)].sort().join('\n')}\n`);
NODE

installed_cli_command_count=0

while IFS= read -r command || [[ -n "$command" ]]; do
  [[ -n "$command" ]] || continue
  [[ "$command" =~ ^[a-z][a-z0-9_-]*(\:[a-z0-9][a-z0-9_-]*)*$ ]] \
    || fail "invalid installed Joomla CLI command name: ${command}"
  output_name="${command//:/__}.txt"
  timeout --signal=TERM --kill-after=2s 20s \
    "${compose[@]}" exec --no-TTY --user www-data --workdir /var/www/html joomla \
    php cli/joomla.php help "$command" --no-interaction --no-ansi \
    >"${cli_help_directory}/${output_name}" \
    </dev/null
  [[ -s "${cli_help_directory}/${output_name}" ]] \
    || fail "Joomla returned empty help for command: ${command}"
  help_bytes="$(wc -c <"${cli_help_directory}/${output_name}" | tr -d '[:space:]')"
  [[ "$help_bytes" -le 131072 ]] \
    || fail "Joomla help exceeded 131072 bytes for command: ${command}"
  installed_cli_command_count=$((installed_cli_command_count + 1))
done <"$installed_cli_commands_file"

[[ "$installed_cli_command_count" -eq 153 ]] \
  || fail "expected 153 installed Joomla CLI help contracts, found ${installed_cli_command_count}"

printf '%s' '{"protocol":"joomla-mcp/1","id":"joomengine-smoke","action":"system.info","input":{}}' \
  | "${compose[@]}" exec --no-TTY --user www-data --workdir /var/www/html joomla \
      php cli/joomla.php joomla:mcp:dispatch --input=- --format=json --no-interaction --no-ansi \
      >"${artifact_directory}/dispatch.json"

node --input-type=module - \
  "${artifact_directory}/describe.json" \
  "${artifact_directory}/self-test.json" \
  "${artifact_directory}/cli-inventory.json" \
  "${artifact_directory}/cli-list.txt" \
  "$CORE_CLI_COMMANDS_FILE" \
  "$cli_help_directory" \
  "${artifact_directory}/dispatch.json" <<'NODE'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const describe = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const selfTest = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const inventory = JSON.parse(readFileSync(process.argv[4], 'utf8'));
const listOutput = readFileSync(process.argv[5], 'utf8');
const coreCommands = readFileSync(process.argv[6], 'utf8').split(/\r?\n/u).filter(Boolean);
const helpDirectory = process.argv[7];
const dispatch = JSON.parse(readFileSync(process.argv[8], 'utf8'));
const names = new Set(Array.isArray(describe.actions) ? describe.actions.map((action) => action.name) : []);

if (describe.protocol !== 'joomla-mcp/1' || describe.companion?.version !== '0.7.0') {
  throw new Error('The installed companion returned an unexpected protocol or package version.');
}

if (!names.has('system.info') || !names.has('content.articles.list') || names.size < 231) {
  throw new Error('The installed companion did not advertise the reviewed action catalogue.');
}

if (
  selfTest.protocol !== 'joomla-mcp/1' ||
  selfTest.ok !== true ||
  selfTest.checks?.pluginEnabled !== true ||
  selfTest.checks?.catalogue?.actionCount !== names.size ||
  selfTest.checks?.dispatch?.action !== 'system.info' ||
  selfTest.checks?.dispatch?.ok !== true
) {
  throw new Error('The installed companion self-test did not validate its catalogue and fixed dispatch.');
}

const installedCommands = new Set(
  Array.isArray(inventory.commands) ? inventory.commands.map((command) => command.name) : [],
);
const companionCommands = [
  'joomla:mcp:cli-inventory',
  'joomla:mcp:describe',
  'joomla:mcp:dispatch',
  'joomla:mcp:self-test',
];
const componentBuilderCommands = [...installedCommands].filter((command) => command.startsWith('componentbuilder:'));

if (
  inventory.protocol !== 'joomla-mcp/1' ||
  inventory.ok !== true ||
  inventory.commandCount !== installedCommands.size ||
  installedCommands.size !== 153 ||
  coreCommands.length !== 38 ||
  componentBuilderCommands.length !== 111 ||
  coreCommands.some((command) => !installedCommands.has(command)) ||
  companionCommands.some((command) => !installedCommands.has(command)) ||
  [...installedCommands].some((command) => !listOutput.includes(command))
) {
  throw new Error('The structured Joomla CLI inventory is incomplete.');
}

for (const command of installedCommands) {
  const helpFile = join(helpDirectory, `${command.replaceAll(':', '__')}.txt`);
  const helpText = readFileSync(helpFile, 'utf8');

  if (helpText.length === 0 || !helpText.includes(command)) {
    throw new Error(`Joomla returned an invalid help contract for ${command}.`);
  }
}

for (const command of inventory.commands) {
  if (
    typeof command.name !== 'string' ||
    typeof command.description !== 'string' ||
    !Array.isArray(command.arguments) ||
    !Array.isArray(command.options)
  ) {
    throw new Error('The structured Joomla CLI inventory contains an invalid command definition.');
  }
}

if (dispatch.protocol !== 'joomla-mcp/1' || dispatch.ok !== true) {
  throw new Error('The unprivileged companion system.info dispatch failed.');
}

if (!/^6\.1\./.test(dispatch.result?.joomlaVersion ?? '') || !/^8\.4\./.test(dispatch.result?.phpVersion ?? '')) {
  throw new Error('The fixture runtime is outside the pinned Joomla 6.1 / PHP 8.4 lane.');
}
NODE

api_response="${artifact_directory}/api-unauthenticated.response"
"${compose[@]}" exec --no-TTY --user www-data joomla \
  curl --silent --show-error --max-time 15 \
    --write-out $'\n__JOOMLA_MCP_HTTP_STATUS__:%{http_code}\n' \
    "${fixture_origin}/api/index.php/v1/content/articles?page%5Blimit%5D=1" \
    >"$api_response"
api_status="$(sed -n 's/^__JOOMLA_MCP_HTTP_STATUS__:\([0-9][0-9][0-9]\)$/\1/p' "$api_response" | tail -n 1)"
sed '/^__JOOMLA_MCP_HTTP_STATUS__:/d' "$api_response" \
  >"${artifact_directory}/api-unauthenticated.json"

case "$api_status" in
  401|403) ;;
  *) fail "the Joomla content API did not enforce authentication (HTTP ${api_status})" ;;
esac

fixture_port="$("${compose[@]}" port joomla 80 | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | tail -n 1)"
[[ "$fixture_port" =~ ^[0-9]+$ ]] || fail 'unable to resolve the fixture Joomla host port'
live_fixture_origin="http://127.0.0.1:${fixture_port}"
readonly live_fixture_origin

api_token_file="${artifact_directory}/.api-token"
"${compose[@]}" exec --no-TTY --user www-data joomla \
  php /fixtures/bootstrap-api-token.php >"$api_token_file"
chmod 0600 -- "$api_token_file"
JOOMLA_MCP_LIVE_API_TOKEN="$(<"$api_token_file")"
[[ "$JOOMLA_MCP_LIVE_API_TOKEN" =~ ^[A-Za-z0-9+/=]+$ ]] \
  || fail 'fixture API-token bootstrap returned an invalid token'
JOOMLA_MCP_LIVE_APPROVAL_SECRET="$(openssl rand -hex 32)"
export JOOMLA_MCP_LIVE_API_TOKEN JOOMLA_MCP_LIVE_APPROVAL_SECRET

cli_root="${artifact_directory}/cli-root"
mkdir -p -- "${cli_root}/cli"
: >"${cli_root}/cli/joomla.php"
cli_wrapper="${artifact_directory}/fixture-php"
docker_binary="$(command -v docker)"
{
  printf '#!/usr/bin/env bash\n'
  printf 'set -Eeuo pipefail\n'
  printf 'shift\n'
  printf 'exec %q exec --interactive --user www-data --workdir /var/www/html %q php /var/www/html/cli/joomla.php "$@"\n' \
    "$docker_binary" "$joomla_container_id"
} >"$cli_wrapper"
chmod 0700 -- "$cli_wrapper"

live_config="${artifact_directory}/live-sites.json"
node --input-type=module - "$live_config" "$live_fixture_origin" "$cli_root" "$cli_wrapper" <<'NODE'
import { writeFileSync } from 'node:fs';

const [file, origin, cliRoot, cliWrapper] = process.argv.slice(2);
const toolsets = [
  'discovery',
  'content.read',
  'content.write',
  'structure.read',
  'structure.write',
  'media.read',
  'media.write',
  'users.read',
  'users.admin',
  'extensions.read',
  'extensions.admin',
  'configuration.read',
  'configuration.write',
  'maintenance.read',
  'maintenance.admin',
  'core-update',
  'cli.discovery',
];
const configuration = {
  defaultSite: 'fixture',
  approval: {
    secretEnv: 'JOOMLA_MCP_LIVE_APPROVAL_SECRET',
    ttlMs: 300000,
    requestTtlMs: 300000,
    allowIndefinite: false,
  },
  sites: {
    fixture: {
      toolsets,
      api: {
        baseUrl: origin,
        tokenEnv: 'JOOMLA_MCP_LIVE_API_TOKEN',
        timeoutMs: 30000,
        maxResponseBytes: 5242880,
        maxPageSize: 100,
        allowInsecureLoopback: true,
      },
      cli: {
        root: cliRoot,
        phpBinary: cliWrapper,
        timeoutMs: 120000,
        maxOutputBytes: 2097152,
      },
    },
  },
};
writeFileSync(file, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
NODE

rm -f -- "$api_token_file"

npm run build --silent
node "${REPOSITORY_ROOT}/dist/bin/joomla-mcp-live-test.js" \
  --config "$live_config" \
  --site fixture \
  --profile full \
  --joomla-path all \
  --mcp-transport all \
  --families all \
  --seed "fixture-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}" \
  --output "${artifact_directory}/live-test" \
  --repository-commit "${GITHUB_SHA:-local}" \
  --fixture-digest "companion-sha256=${package_sha256}" \
  --fixture-digest "joomla-image=${JOOMLA_FIXTURE_IMAGE}" \
  --fixture-digest "database-image=${JOOMLA_FIXTURE_DATABASE_IMAGE}" \
  --non-interactive \
  --confirm-mutations \
  --disposable \
  --retain-demo

collect_diagnostics
for command in \
  'joomla:mcp:describe --format=json --no-interaction --no-ansi' \
  'joomla:mcp:self-test --format=json --no-interaction --no-ansi' \
  'joomla:mcp:cli-inventory --format=json --no-interaction --no-ansi'; do
  grep -Fq -- "Joomla CLI command succeeded: ${command}" "${artifact_directory}/compose.log" \
    || fail "JoomEngine did not confirm the bootstrap command: ${command}"
done

joomla_image_id="$(docker inspect --format '{{.Image}}' "$joomla_container_id")"
joomla_repo_digests="$(docker image inspect --format '{{join .RepoDigests ","}}' "$joomla_image_id")"
database_container_id="$("${compose[@]}" ps --quiet mariadb)"
database_image_id="$(docker inspect --format '{{.Image}}' "$database_container_id")"
database_repo_digests="$(docker image inspect --format '{{join .RepoDigests ","}}' "$database_image_id")"

export JOOMLA_FIXTURE_API_STATUS="$api_status"
export JOOMLA_FIXTURE_DATABASE_REPO_DIGESTS="$database_repo_digests"
export JOOMLA_FIXTURE_JOOMLA_REPO_DIGESTS="$joomla_repo_digests"
export JOOMLA_FIXTURE_PACKAGE_SHA256="$package_sha256"
export JOOMLA_FIXTURE_REPOSITORY_COMMIT="${GITHUB_SHA:-local}"
node --input-type=module - \
  "${artifact_directory}/self-test.json" \
  "${artifact_directory}/cli-inventory.json" \
  "$CORE_CLI_COMMANDS_FILE" \
  "${artifact_directory}/dispatch.json" \
  >"${artifact_directory}/evidence.json" <<'NODE'
import { readFileSync } from 'node:fs';

const selfTest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const inventory = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const coreCommands = readFileSync(process.argv[4], 'utf8').split(/\r?\n/u).filter(Boolean);
const dispatch = JSON.parse(readFileSync(process.argv[5], 'utf8'));
const componentBuilderCommands = inventory.commands.filter((command) => command.name.startsWith('componentbuilder:'));
const evidence = {
  schema: 'vdm.joomla-mcp.fixture-evidence/v1',
  repositoryCommit: process.env.JOOMLA_FIXTURE_REPOSITORY_COMMIT,
  companionPackageSha256: process.env.JOOMLA_FIXTURE_PACKAGE_SHA256,
  companionVersion: '0.7.0',
  joomlaVersion: dispatch.result.joomlaVersion,
  phpVersion: dispatch.result.phpVersion,
  databaseFamily: 'MariaDB',
  joomlaImage: process.env.JOOMLA_FIXTURE_IMAGE,
  joomlaRepoDigests: process.env.JOOMLA_FIXTURE_JOOMLA_REPO_DIGESTS.split(',').filter(Boolean),
  databaseImage: process.env.JOOMLA_FIXTURE_DATABASE_IMAGE,
  databaseRepoDigests: process.env.JOOMLA_FIXTURE_DATABASE_REPO_DIGESTS.split(',').filter(Boolean),
  unauthenticatedApiStatus: Number(process.env.JOOMLA_FIXTURE_API_STATUS),
  companionSelfTest: {
    pluginEnabled: selfTest.checks.pluginEnabled,
    actionCount: selfTest.checks.catalogue.actionCount,
    dispatchAction: selfTest.checks.dispatch.action,
  },
  cliInventory: {
    commandCount: inventory.commandCount,
    namespaces: inventory.namespaces,
    componentBuilderCommandCount: componentBuilderCommands.length,
  },
  cliHelpContracts: {
    coreCommandCount: coreCommands.length,
    installedCommandCount: inventory.commandCount,
  },
  assertions: [
    'fresh Joomla installation',
    'companion package installation and activation',
    'JoomEngine bootstrap CLI execution',
    'companion self-test feedback',
    'structured installed CLI inventory',
    'native list and help contract for every installed Joomla CLI command',
    'companion catalogue description as www-data',
    'companion system.info dispatch as www-data',
    'content API authentication boundary',
    'catalogue-complete live MCP validation through stdio and Streamable HTTP',
    'CRUD and administrative validation through Joomla API and companion CLI',
    'redacted Markdown, JSON, JUnit, and per-action failure evidence',
  ],
};

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
NODE

printf 'JoomEngine Joomla 6.1 integration fixture passed. Evidence: %s\n' \
  "${artifact_directory}/evidence.json"
