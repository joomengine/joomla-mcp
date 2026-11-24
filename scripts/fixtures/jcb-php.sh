#!/bin/sh
# Only the disposable fixture config uses this launcher. Keep native protocol
# streams intact and collect known source-language identifiers for job warnings.
set -eu
if [ -n "${JOOMLA_MCP_JCB_ARTIFACT_DIR:-}" ]; then
  root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
  exec php -d "auto_prepend_file=$root/tests/fixtures/joomengine/jcb-compiler-warnings.php" "$@"
fi
exec php "$@"
