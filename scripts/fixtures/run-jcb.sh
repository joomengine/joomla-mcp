#!/usr/bin/env bash

# Invoked only for the disposable container owned by run-joomengine.sh.
set -Eeuo pipefail
container="${1:?Expected fixture container ID}"
evidence="${2:?Expected artifact directory}"
: "${JOOMLA_MCP_LIVE_API_TOKEN:?Expected the disposable fixture token}"
: "${JOOMLA_MCP_LIVE_APPROVAL_SECRET:?Expected the disposable approval secret}"
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
run=(docker exec --user www-data --workdir /var/www/html "$container")
runtime=/tmp/joomla-mcp-jcb-fixture
# Same native installer ZIP distributed by the v6.2.0 update server, pinned by commit.
package_commit=c39005da5eec7011847831618dbb9cb11dba73b4
"${run[@]}" curl --fail --silent --show-error --location --retry 3 --max-time 180 \
  "https://github.com/joomengine/pkg-component-builder/archive/${package_commit}.zip" -o /tmp/mcp-jcb-package.zip
"${run[@]}" php cli/joomla.php extension:install --path=/tmp/mcp-jcb-package.zip --no-interaction --no-ansi

# Run Node and its PHP child as the same Joomla OS user, with the same private
# workspace. Copy the Linux Node binary even when the Docker host runs macOS.
"${run[@]}" mkdir -m 0700 "$runtime"
docker run --rm --entrypoint cat node:22.17.1-bookworm-slim /usr/local/bin/node \
  | docker exec -i --user www-data "$container" sh -c 'cat > "$1/node" && chmod 0700 "$1/node"' sh "$runtime"
tar -C "$root" -cf - package.json node_modules dist scripts/fixtures/verify-jcb.mjs \
  tests/fixtures/joomengine/jcb-denied-token.php \
  | docker exec -i --user www-data "$container" tar -C "$runtime" -xf -

"${run[@]}" php cli/joomla.php user:add --username=mcpjcbreader --name='JCB ACL fixture' \
  --email=jcb-acl@example.invalid --password="$(openssl rand -hex 24)" --usergroup=Registered --no-interaction --no-ansi
# Pass tokens only through the process environment. The archived report contains
# assertion names and results, never token or acknowledgement values.
set +e
docker exec --user www-data --workdir "$runtime" \
  --env JOOMLA_MCP_LIVE_API_TOKEN --env JOOMLA_MCP_LIVE_APPROVAL_SECRET \
  "$container" "$runtime/node" scripts/fixtures/verify-jcb.mjs --disposable
status=$?
set -e
docker cp "${container}:${runtime}/jcb-evidence.json" "${evidence}/jcb-evidence.json"
exit "$status"
