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
# Same native installer ZIP distributed by the v6.2.1 update server, pinned by commit.
package_commit=1aa00148cf4726a6eb0754d56250ea2411bc9951
"${run[@]}" curl --fail --silent --show-error --location --retry 3 --max-time 180 \
  "https://github.com/joomengine/pkg-component-builder/archive/${package_commit}.zip" -o /tmp/mcp-jcb-package.zip
"${run[@]}" php cli/joomla.php extension:install --path=/tmp/mcp-jcb-package.zip --no-interaction --no-ansi

# Node and PHP run as the same account and share the same private workspace.
# Reuse setup-node's binary on Linux CI. Use a Linux runtime image only when
# the host binary cannot run in the Joomla container (e.g. a macOS host).
"${run[@]}" mkdir -m 0700 "$runtime"
copy_node=(docker exec -i --user www-data "$container" sh -c 'cat > "$1/node" && chmod 0700 "$1/node"' sh "$runtime")
if [[ "$(uname -s)" != Linux ]] || ! "${copy_node[@]}" <"$(command -v node)" || ! "${run[@]}" "$runtime/node" --version; then
  docker run --rm --entrypoint cat node:22.17.1-bookworm-slim /usr/local/bin/node | "${copy_node[@]}"
fi
cd -- "$root"
tar -cf - package.json node_modules dist scripts/fixtures/verify-jcb.mjs scripts/fixtures/jcb-*.mjs scripts/fixtures/jcb-php.sh \
  tests/fixtures/joomengine/jcb-*.php \
  | docker exec -i --user www-data "$container" tar -C "$runtime" -xf -

# Reuse the sibling project's isolated Gitea contents fixture at a verified commit.
"${run[@]}" curl --fail --silent --show-error --location --retry 3 --max-time 60 \
  https://raw.githubusercontent.com/joomengine/mcp_component/aedd96a7be89d54b5dae10a70067aeb7e191e123/tests/golden-image/RepositoryFixture.php \
  -o "$runtime/RepositoryFixture.php"
printf '%s  %s\n' 32217bc8d374c925453f58944ee288ee1df07e9ffd4760e70d80a3becb1109ff "$runtime/RepositoryFixture.php" \
  | docker exec -i --user www-data "$container" sha256sum --check --status

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
