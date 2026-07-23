#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
readonly REPOSITORY_ROOT

fail() {
  printf 'deployment validation failed: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local text="$2"
  grep -Fq -- "$text" "$file" || fail "$file does not contain required setting: $text"
}

assert_not_contains() {
  local file="$1"
  local text="$2"
  if grep -Fq -- "$text" "$file"; then
    fail "$file contains forbidden setting: $text"
  fi
}

cd -- "$REPOSITORY_ROOT"

for file in \
  Dockerfile \
  deploy/compose.yaml \
  deploy/sites.container.example.json \
  deploy/systemd/joomla-mcp.service \
  .github/workflows/release.yml \
  scripts/release/verify-version.mjs \
  scripts/deploy/compose-rollout.sh \
  scripts/deploy/healthcheck.mjs \
  scripts/deploy/systemd-rollout.sh \
  scripts/deploy/wait-healthy.mjs; do
  [[ -s "$file" ]] || fail "required artifact is missing or empty: $file"
done

./tests/fixtures/static-joomengine.test.sh

node --check scripts/deploy/healthcheck.mjs
node --check scripts/deploy/wait-healthy.mjs
node --check scripts/release/verify-version.mjs
node --check tests/deploy/healthcheck.check.mjs
bash -n scripts/deploy/compose-rollout.sh
bash -n scripts/deploy/systemd-rollout.sh
bash -n tests/deploy/static-deployment.test.sh
node tests/deploy/healthcheck.check.mjs
if scripts/deploy/compose-rollout.sh apply 'registry.example.test/joomla-mcp:latest' >/dev/null 2>&1; then
  fail 'compose rollout accepted a mutable image tag'
fi

node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' \
  deploy/sites.container.example.json
validation_directory="$(mktemp -d)"
node --input-type=module - \
  deploy/sites.container.example.json \
  "${validation_directory}/sites.json" \
  "${validation_directory}/permission-grants.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const source = JSON.parse(readFileSync(process.argv[2], 'utf8'));
source.approval.grantStorePath = process.argv[4];
writeFileSync(process.argv[3], `${JSON.stringify(source, null, 2)}\n`, 'utf8');
writeFileSync(process.argv[4], '{"version":1,"grants":[]}\n', { encoding: 'utf8', mode: 0o600 });
NODE
chmod 0600 "${validation_directory}/permission-grants.json"
JOOMLA_PRODUCTION_TOKEN=deployment-validation-token \
JOOMLA_MCP_APPROVAL_SECRET=deployment-validation-secret-32-characters \
JOOMLA_MCP_CONFIG="${validation_directory}/sites.json" \
  node --input-type=module -e \
  'import { loadConfiguration } from "./dist/config/load.js"; await loadConfiguration(process.env.JOOMLA_MCP_CONFIG);'
rm -r -- "$validation_directory"

assert_contains Dockerfile 'USER 10001:10001'
assert_contains Dockerfile 'STOPSIGNAL SIGTERM'
assert_contains Dockerfile 'HEALTHCHECK --interval=30s'
assert_contains Dockerfile 'org.opencontainers.image.licenses="GPL-2.0-or-later"'
assert_contains Dockerfile 'COPY --chown=10001:10001 LICENSE ./LICENSE'
assert_not_contains Dockerfile ':latest'

assert_contains deploy/compose.yaml 'JOOMLA_MCP_IMAGE:?Set JOOMLA_MCP_IMAGE to an immutable image digest'
assert_contains deploy/compose.yaml 'user: "10001:10001"'
assert_contains deploy/compose.yaml 'read_only: true'
assert_contains deploy/compose.yaml 'no-new-privileges:true'
assert_contains deploy/compose.yaml 'pids_limit:'
assert_contains deploy/compose.yaml 'mem_limit:'
assert_contains deploy/compose.yaml 'stop_grace_period: 35s'
assert_contains deploy/compose.yaml 'JOOMLA_MCP_HEALTH_ORIGIN:'
assert_contains deploy/compose.yaml 'target: /var/lib/joomla-mcp'
assert_contains deploy/compose.yaml 'permission-grants:'
assert_contains deploy/compose.yaml 'max-size:'
assert_not_contains deploy/compose.yaml ':latest'
assert_not_contains deploy/compose.yaml 'build:'

assert_contains deploy/systemd/joomla-mcp.service 'WorkingDirectory=/opt/joomla-mcp/current'
assert_contains deploy/systemd/joomla-mcp.service 'ExecStartPost=/usr/bin/node /opt/joomla-mcp/current/scripts/deploy/wait-healthy.mjs'
assert_contains deploy/systemd/joomla-mcp.service 'Environment=JOOMLA_MCP_HEALTH_PATH=/readyz'
assert_contains deploy/systemd/joomla-mcp.service 'ProtectSystem=strict'
assert_contains deploy/systemd/joomla-mcp.service 'NoNewPrivileges=true'
assert_contains deploy/systemd/joomla-mcp.service 'CapabilityBoundingSet='
assert_contains deploy/systemd/joomla-mcp.service 'TimeoutStopSec=35'
assert_contains deploy/systemd/joomla-mcp.service 'StateDirectory=joomla-mcp'
assert_contains deploy/systemd/joomla-mcp.service 'StateDirectoryMode=0700'
assert_not_contains deploy/systemd/joomla-mcp.service 'MemoryDenyWriteExecute=true'

assert_contains scripts/deploy/compose-rollout.sh 'JOOMLA_MCP_READINESS_PATH:-/readyz'
assert_contains scripts/deploy/compose-rollout.sh "wait_ready \"\$timeout\""

assert_contains .github/workflows/release.yml 'workflow_dispatch:'
assert_contains .github/workflows/release.yml 'joomengine-mcp-for-joomla-deployment-'
assert_contains .github/workflows/release.yml 'pkg_joomlamcp-'
assert_contains .github/workflows/release.yml 'spdx.json'
assert_contains .github/workflows/release.yml 'SHA256SUMS'

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck scripts/deploy/compose-rollout.sh scripts/deploy/systemd-rollout.sh scripts/deploy/validate.sh scripts/fixtures/run-joomengine.sh tests/deploy/static-deployment.test.sh tests/fixtures/static-joomengine.test.sh
fi

if command -v hadolint >/dev/null 2>&1; then
  hadolint Dockerfile
fi

if command -v systemd-analyze >/dev/null 2>&1 \
  && systemd-analyze security --help 2>&1 | grep -Fq -- '--offline'; then
  systemd-analyze security --offline=yes deploy/systemd/joomla-mcp.service >/dev/null
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  temporary_compose_directory="$(mktemp -d)"
  trap 'rm -r -- "$temporary_compose_directory"' EXIT
  cp -- deploy/compose.yaml "${temporary_compose_directory}/compose.yaml"
  cp -- deploy/sites.container.example.json "${temporary_compose_directory}/sites.json"
  : > "${temporary_compose_directory}/secrets.env"
  JOOMLA_MCP_IMAGE='registry.example.test/joomla-mcp@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    docker compose \
      --project-directory "$temporary_compose_directory" \
      -f "${temporary_compose_directory}/compose.yaml" \
      config --quiet
fi

printf 'Static deployment validation passed.\n'
