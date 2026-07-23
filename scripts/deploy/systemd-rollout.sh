#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

readonly INSTALL_ROOT=/opt/joomla-mcp
readonly RELEASE_ROOT=/opt/joomla-mcp/releases
readonly CURRENT_LINK=/opt/joomla-mcp/current
readonly PREVIOUS_LINK=/opt/joomla-mcp/previous
readonly SERVICE=joomla-mcp.service

usage() {
  printf 'Usage:\n  sudo %s activate /opt/joomla-mcp/releases/RELEASE\n  sudo %s rollback\n' "$0" "$0" >&2
}

fail() {
  printf 'joomla-mcp systemd rollout: %s\n' "$*" >&2
  exit 1
}

canonical_release() {
  local requested="$1"
  local canonical
  local unsafe_path
  local link
  local link_target
  [[ "$requested" == "${RELEASE_ROOT}/"* ]] || fail "release must be beneath ${RELEASE_ROOT}"
  canonical="$(realpath -e -- "$requested")"
  [[ "$canonical" == "${RELEASE_ROOT}/"* && "$canonical" != "$RELEASE_ROOT" ]] \
    || fail "release resolves outside ${RELEASE_ROOT}"
  [[ -f "${canonical}/dist/bin/joomla-mcp-http.js" ]] || fail 'release has no built HTTP entry point'
  [[ -f "${canonical}/scripts/deploy/wait-healthy.mjs" ]] || fail 'release has no startup probe'
  [[ -d "${canonical}/node_modules" ]] || fail 'release has no production node_modules tree'
  unsafe_path="$(find "$canonical" -xdev \( -type f -o -type d \) \( ! -user root -o -perm /022 \) -print -quit)"
  [[ -z "$unsafe_path" ]] || fail "release content must be root-owned and not group/other-writable: $unsafe_path"
  while IFS= read -r -d '' link; do
    link_target="$(readlink -e -- "$link")" || fail "release contains a broken symbolic link: $link"
    [[ "$link_target" == "${canonical}/"* ]] || fail "release symbolic link escapes the release directory: $link"
  done < <(find "$canonical" -xdev -type l -print0)
  printf '%s\n' "$canonical"
}

link_target() {
  local link="$1"
  [[ -L "$link" ]] || fail "release link does not exist: $link"
  canonical_release "$(readlink -e -- "$link")"
}

set_link() {
  local link="$1"
  local target="$2"
  local temporary="${link}.new"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || fail "temporary link already exists: $temporary"
  ln -s -- "$target" "$temporary"
  mv -fT -- "$temporary" "$link"
}

restart_and_verify() {
  systemctl restart "$SERVICE"
  systemctl is-active --quiet "$SERVICE"
}

activate() {
  local requested="$1"
  local target
  local old=''
  target="$(canonical_release "$requested")"
  if [[ -L "$CURRENT_LINK" ]]; then
    old="$(link_target "$CURRENT_LINK")"
  fi
  [[ "$target" != "$old" ]] || fail 'requested release is already active'

  if [[ -n "$old" ]]; then
    set_link "$PREVIOUS_LINK" "$old"
  fi
  set_link "$CURRENT_LINK" "$target"

  if ! restart_and_verify; then
    if [[ -n "$old" ]]; then
      printf 'Activation failed; restoring %s.\n' "$old" >&2
      set_link "$CURRENT_LINK" "$old"
      restart_and_verify || fail 'activation and automatic rollback both failed; inspect the systemd journal immediately'
    fi
    fail 'activation failed'
  fi
  printf 'Activated %s\n' "$target"
}

rollback() {
  local current
  local previous
  current="$(link_target "$CURRENT_LINK")"
  previous="$(link_target "$PREVIOUS_LINK")"
  [[ "$current" != "$previous" ]] || fail 'current and previous releases are identical'
  set_link "$CURRENT_LINK" "$previous"
  if ! restart_and_verify; then
    set_link "$CURRENT_LINK" "$current"
    restart_and_verify || fail 'rollback and restoration both failed; inspect the systemd journal immediately'
    fail 'rollback failed; the current release was restored'
  fi
  set_link "$PREVIOUS_LINK" "$current"
  printf 'Rolled back to %s\n' "$previous"
}

[[ "${EUID}" -eq 0 ]] || fail 'run this command as root'
command -v systemctl >/dev/null 2>&1 || fail 'systemctl is required'
[[ -d "$INSTALL_ROOT" && -d "$RELEASE_ROOT" ]] || fail 'the versioned installation layout is missing'

case "${1:-}" in
  activate)
    [[ $# -eq 2 ]] || { usage; exit 2; }
    activate "$2"
    ;;
  rollback)
    [[ $# -eq 1 ]] || { usage; exit 2; }
    rollback
    ;;
  *)
    usage
    exit 2
    ;;
esac
