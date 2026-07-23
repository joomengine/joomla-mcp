#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
readonly REPOSITORY_ROOT

cd -- "$REPOSITORY_ROOT"
npm run build
exec "${SCRIPT_DIR}/../../tests/deploy/static-deployment.test.sh"
