#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
readonly REPOSITORY_ROOT
readonly DEPLOY_DIR="${REPOSITORY_ROOT}/deploy"
readonly COMPOSE_FILE="${DEPLOY_DIR}/compose.yaml"
readonly RELEASE_FILE="${DEPLOY_DIR}/.release.env"
readonly PREVIOUS_FILE="${DEPLOY_DIR}/.release.env.previous"
readonly LOCK_DIR="${DEPLOY_DIR}/.rollout.lock"
readonly SERVICE="joomla-mcp"

usage() {
  printf 'Usage:\n  %s apply IMAGE@sha256:DIGEST\n  %s rollback\n  %s status\n' "$0" "$0" "$0" >&2
}

fail() {
  printf 'joomla-mcp rollout: %s\n' "$*" >&2
  exit 1
}

require_file() {
  [[ -f "$1" && ! -L "$1" ]] || fail "required regular file is missing: $1"
}

validate_image() {
  [[ "$1" =~ ^[a-z0-9]+([.-][a-z0-9]+)*(:[0-9]{1,5})?(/[a-z0-9]+([._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$ ]] \
    || fail 'image must be an immutable registry reference ending in @sha256:<64 lowercase hex characters>'
}

read_image() {
  local file="$1"
  local line
  require_file "$file"
  [[ "$(wc -l < "$file")" -eq 1 ]] || fail "invalid release state: $file"
  IFS= read -r line < "$file"
  [[ "$line" == JOOMLA_MCP_IMAGE=* ]] || fail "invalid release state: $file"
  line="${line#JOOMLA_MCP_IMAGE=}"
  validate_image "$line"
  printf '%s\n' "$line"
}

write_release() {
  local destination="$1"
  local image="$2"
  local temporary
  temporary="$(mktemp "${DEPLOY_DIR}/.release.env.tmp.XXXXXX")"
  printf 'JOOMLA_MCP_IMAGE=%s\n' "$image" > "$temporary"
  chmod 0600 "$temporary"
  mv -fT -- "$temporary" "$destination"
}

compose() {
  docker compose --project-directory "$DEPLOY_DIR" --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" "$@"
}

wait_timeout() {
  local value="${JOOMLA_MCP_ROLLOUT_TIMEOUT_SECONDS:-90}"
  [[ "$value" =~ ^[0-9]+$ ]] || fail 'JOOMLA_MCP_ROLLOUT_TIMEOUT_SECONDS must be an integer'
  (( value >= 10 && value <= 600 )) || fail 'JOOMLA_MCP_ROLLOUT_TIMEOUT_SECONDS must be between 10 and 600'
  printf '%s\n' "$value"
}

wait_ready() {
  local timeout_seconds="$1"
  JOOMLA_MCP_HEALTH_PATH="${JOOMLA_MCP_READINESS_PATH:-/readyz}" \
  JOOMLA_MCP_HEALTH_PORT="${JOOMLA_MCP_HEALTH_PORT:-${JOOMLA_MCP_BIND_PORT:-3000}}" \
  JOOMLA_MCP_STARTUP_TIMEOUT_MS="$((timeout_seconds * 1000))" \
    node "${SCRIPT_DIR}/wait-healthy.mjs"
}

preflight() {
  command -v docker >/dev/null 2>&1 || fail 'docker is required'
  docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required'
  require_file "$COMPOSE_FILE"
  require_file "${DEPLOY_DIR}/sites.json"
  require_file "${DEPLOY_DIR}/secrets.env"

  local secret_mode
  local config_mode
  secret_mode="$(stat -c '%a' "${DEPLOY_DIR}/secrets.env")"
  (( (8#$secret_mode & 8#077) == 0 )) || fail 'deploy/secrets.env must not be accessible by group or other users'
  config_mode="$(stat -c '%a' "${DEPLOY_DIR}/sites.json")"
  (( (8#$config_mode & 8#022) == 0 )) || fail 'deploy/sites.json must not be writable by group or other users'
  (( (8#$config_mode & 8#004) != 0 )) \
    || fail 'deploy/sites.json must be world-readable by the fixed container UID (it must never contain secret values)'
}

acquire_lock() {
  mkdir -- "$LOCK_DIR" 2>/dev/null || fail 'another deployment operation is active'
  trap 'rmdir -- "$LOCK_DIR" 2>/dev/null || true' EXIT
}

activate() {
  local new_image="$1"
  local old_image=''
  local timeout
  validate_image "$new_image"
  preflight
  acquire_lock
  timeout="$(wait_timeout)"

  if [[ -f "$RELEASE_FILE" ]]; then
    old_image="$(read_image "$RELEASE_FILE")"
  fi
  write_release "$RELEASE_FILE" "$new_image"

  if ! compose config --quiet \
    || ! compose pull "$SERVICE" \
    || ! compose up --detach --remove-orphans --wait --wait-timeout "$timeout" "$SERVICE" \
    || ! wait_ready "$timeout"; then
    if [[ -n "$old_image" ]]; then
      printf 'Deployment failed; restoring %s.\n' "$old_image" >&2
      write_release "$RELEASE_FILE" "$old_image"
      if ! compose up --detach --remove-orphans --wait --wait-timeout "$timeout" "$SERVICE" \
        || ! wait_ready "$timeout"; then
        fail 'deployment and automatic rollback both failed; inspect docker compose logs immediately'
      fi
    fi
    fail 'deployment failed'
  fi

  if [[ -n "$old_image" && "$old_image" != "$new_image" ]]; then
    write_release "$PREVIOUS_FILE" "$old_image"
  fi
  printf 'Activated %s\n' "$new_image"
}

rollback() {
  local current_image
  local previous_image
  local timeout
  preflight
  acquire_lock
  current_image="$(read_image "$RELEASE_FILE")"
  previous_image="$(read_image "$PREVIOUS_FILE")"
  [[ "$current_image" != "$previous_image" ]] || fail 'current and previous image references are identical'
  timeout="$(wait_timeout)"

  write_release "$RELEASE_FILE" "$previous_image"
  if ! compose up --detach --remove-orphans --wait --wait-timeout "$timeout" "$SERVICE" \
    || ! wait_ready "$timeout"; then
    write_release "$RELEASE_FILE" "$current_image"
    if ! compose up --detach --remove-orphans --wait --wait-timeout "$timeout" "$SERVICE" \
      || ! wait_ready "$timeout"; then
      fail 'rollback and restoration both failed; inspect docker compose logs immediately'
    fi
    fail 'rollback failed; the prior running release was restored'
  fi
  write_release "$PREVIOUS_FILE" "$current_image"
  printf 'Rolled back to %s\n' "$previous_image"
}

status() {
  preflight
  read_image "$RELEASE_FILE" >/dev/null
  compose ps "$SERVICE"
}

case "${1:-}" in
  apply)
    [[ $# -eq 2 ]] || { usage; exit 2; }
    activate "$2"
    ;;
  rollback)
    [[ $# -eq 1 ]] || { usage; exit 2; }
    rollback
    ;;
  status)
    [[ $# -eq 1 ]] || { usage; exit 2; }
    status
    ;;
  *)
    usage
    exit 2
    ;;
esac
