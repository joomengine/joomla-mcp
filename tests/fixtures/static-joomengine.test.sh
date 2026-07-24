#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIRECTORY
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIRECTORY}/../.." && pwd -P)"
readonly REPOSITORY_ROOT
COMPOSE_FILE="tests/fixtures/joomengine/compose.yaml"
API_BOOTSTRAP="tests/fixtures/joomengine/bootstrap-api-token.php"
RUNNER="scripts/fixtures/run-joomengine.sh"
CORE_CLI_COMMANDS_FILE="tests/fixtures/joomengine/core-cli-commands.txt"

fail() {
  printf 'JoomEngine fixture validation failed: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  grep -Fq -- "$2" "$1" || fail "$1 does not contain required text: $2"
}

assert_not_contains() {
  if grep -Fq -- "$2" "$1"; then
    fail "$1 contains forbidden text: $2"
  fi
}

cd -- "$REPOSITORY_ROOT"

for file in "$COMPOSE_FILE" "$RUNNER" "$CORE_CLI_COMMANDS_FILE" "$API_BOOTSTRAP" companion/plugin/script.php; do
  [[ -s "$file" ]] || fail "required file is missing or empty: $file"
done

bash -n "$RUNNER"
bash -n tests/fixtures/static-joomengine.test.sh

assert_contains "$COMPOSE_FILE" 'JOOMLA_FIXTURE_IMAGE:-octoleo/joomengine:6@sha256:5fbcccb6275cc8336d22cad563082e09824bd04e0035bc1837787be8f16b2372}'
assert_contains "$COMPOSE_FILE" 'mariadb:11.4@sha256:a794d9eb009e20de605858a11f32f63b4075cbd197c650436f0e3b457e4caed7'
assert_contains "$COMPOSE_FILE" 'axllent/mailpit:v1.30.5'
assert_contains "$COMPOSE_FILE" 'JOOMLA_EXTENSIONS_PATHS: /fixtures/pkg_joomlamcp.zip'
assert_contains "$COMPOSE_FILE" 'JOOMLA_CLI_COMMANDS:'
assert_contains "$COMPOSE_FILE" 'joomla:mcp:describe --format=json'
assert_contains "$COMPOSE_FILE" 'joomla:mcp:self-test --format=json'
assert_contains "$COMPOSE_FILE" 'joomla:mcp:cli-inventory --format=json'
assert_not_contains "$COMPOSE_FILE" 'cache:clean'
assert_not_contains "$COMPOSE_FILE" 'extension:list'
assert_contains "$COMPOSE_FILE" 'read_only: true'
assert_contains "$COMPOSE_FILE" 'internal: true'
assert_contains "$COMPOSE_FILE" 'host-edge:'
assert_contains "$COMPOSE_FILE" '"127.0.0.1:0:80"'
assert_contains "$COMPOSE_FILE" 'JOOMLA_FIXTURE_API_BOOTSTRAP'
assert_not_contains "$COMPOSE_FILE" ':latest'
assert_not_contains "$COMPOSE_FILE" 'privileged: true'
assert_not_contains "$COMPOSE_FILE" 'network_mode: host'

assert_contains "$RUNNER" 'down --volumes --remove-orphans'
assert_contains "$RUNNER" 'exec --no-TTY --user www-data'
assert_contains "$RUNNER" "fixture_origin='http://127.0.0.1'"
assert_contains "$RUNNER" 'joomla:mcp:describe'
assert_contains "$RUNNER" 'joomla:mcp:self-test'
assert_contains "$RUNNER" 'joomla:mcp:cli-inventory'
assert_contains "$RUNNER" 'joomla:mcp:dispatch'
assert_contains "$RUNNER" "php cli/joomla.php help \"\$command\" --no-interaction --no-ansi"
assert_contains "$RUNNER" '</dev/null'
assert_contains "$RUNNER" 'installed_cli_command_count" -eq 153'
assert_contains "$RUNNER" 'php cli/joomla.php list --no-interaction --no-ansi'
assert_contains "$RUNNER" 'timeout --signal=TERM --kill-after=2s 20s'
assert_contains "$RUNNER" 'api/index.php/v1/content/articles'
assert_contains "$RUNNER" 'docker image inspect'
assert_contains "$RUNNER" 'joomla-mcp-live-test.js'
assert_contains "$RUNNER" '--confirm-mutations'
assert_contains "$RUNNER" '--disposable'
assert_contains "$RUNNER" '--mcp-transport all'
assert_contains "$RUNNER" '--joomla-path all'
assert_contains "$RUNNER" 'smtphost=mailpit'
assert_contains "$RUNNER" "updateTokenEnv: 'JOOMLA_MCP_LIVE_UPDATE_TOKEN'"
assert_contains "$RUNNER" 'JOOMLA_MCP_LIVE_UPDATE_TOKEN'
assert_contains "$RUNNER" '--cleanup'
assert_not_contains "$RUNNER" 'eval '
assert_contains "$API_BOOTSTRAP" "'profile_value' => \$encodedSeed"
assert_contains "$API_BOOTSTRAP" "'profile_value' => '1'"
assert_contains "$API_BOOTSTRAP" 'joomla-mcp-live-prerequisite.png'
assert_contains "$API_BOOTSTRAP" 'JOOMLA_MCP_LIVE_PREREQUISITE_ADMINISTRATOR'
assert_contains "$API_BOOTSTRAP" 'JOOMLA_MCP_LIVE_PREREQUISITE_SITE'
assert_contains "$API_BOOTSTRAP" 'Joomla MCP live prerequisite consent'
assert_contains "$API_BOOTSTRAP" "status, request_type"
assert_contains "$API_BOOTSTRAP" "type = 'extension'"
assert_contains "$API_BOOTSTRAP" 'core-update.xml'
assert_contains "$API_BOOTSTRAP" '<supported_databases mysql="8.0.13" mariadb="10.4.0" />'
assert_not_contains "$API_BOOTSTRAP" '<database type='
assert_contains "$API_BOOTSTRAP" "'updateToken' => \$updateToken"
assert_not_contains "$API_BOOTSTRAP" "json_encode(\$encodedSeed"
assert_not_contains "$API_BOOTSTRAP" 'json_encode(true'

if command -v php >/dev/null 2>&1; then
  php -l "$API_BOOTSTRAP"
fi

[[ "$(sed '/^$/d' "$CORE_CLI_COMMANDS_FILE" | wc -l | tr -d '[:space:]')" == '38' ]] \
  || fail "$CORE_CLI_COMMANDS_FILE must contain exactly 38 command names"
assert_contains "$CORE_CLI_COMMANDS_FILE" 'core:update'
assert_contains "$CORE_CLI_COMMANDS_FILE" 'database:import'
assert_contains "$CORE_CLI_COMMANDS_FILE" 'extension:install'
assert_contains "$CORE_CLI_COMMANDS_FILE" 'user:reset-password'

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$RUNNER" tests/fixtures/static-joomengine.test.sh
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  temporary_directory="$(mktemp -d)"
  trap 'rm -rf -- "$temporary_directory"' EXIT
  : >"${temporary_directory}/pkg_joomlamcp.zip"
  JOOMLA_FIXTURE_ADMIN_PASSWORD='fixture-admin-password-12345' \
  JOOMLA_FIXTURE_COMPANION_ZIP="${temporary_directory}/pkg_joomlamcp.zip" \
  JOOMLA_FIXTURE_API_BOOTSTRAP="${REPOSITORY_ROOT}/${API_BOOTSTRAP}" \
  JOOMLA_FIXTURE_DATABASE_NAME='joomlamcp' \
  JOOMLA_FIXTURE_DATABASE_PASSWORD='fixture-database-password' \
  JOOMLA_FIXTURE_DATABASE_ROOT_PASSWORD='fixture-root-password' \
  JOOMLA_FIXTURE_DATABASE_USER='joomlamcp' \
    docker compose --file "$COMPOSE_FILE" config --quiet
fi

printf 'Static JoomEngine fixture validation passed.\n'
