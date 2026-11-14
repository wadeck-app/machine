#!/usr/bin/env bash
# Verifies, in an isolated temp environment, that a published version of @wadeck-app/machine-cli installs and works.
#
# Usage:       bash packages/machine-cli/ci/scripts/verify-install.sh <version>
# Run locally: needs bash (git-bash on Windows), node >= 22, npm configured for GitHub Packages
#              (@wadeck-app:registry=https://npm.pkg.github.com and a token with read:packages).
#              Nothing outside a temp folder is touched: the global npm prefix, MACHINE_CONFIG_DIR, the app-core config folder and the
#              home are redirected. The daemon it starts listens on loopback ports only and is stopped at the end (or on a failure).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/verify-lib.sh"

VERSION="${1:-}"
[ -n "$VERSION" ] || fail "usage: verify-install.sh <version>"

isolate_env
trap cleanup_daemon EXIT

step "(a) npm install -g @wadeck-app/machine-cli@$VERSION"
install_global "@wadeck-app/machine-cli@$VERSION"
assert_platform_package_installed

step "(b) machine --version prints exactly the version"
ACTUAL="$(installed_version)"
assert_equals "machine --version" "$VERSION" "$ACTUAL"

step "(c) machine cli self-check exits 0"
run_machine cli self-check || fail "machine cli self-check exited with status $?"
echo "ok: self-check passed"

step "(d) functional smoke test: init, daemon, status, stop"
run_machine init --name ci-verify || fail "machine init exited with status $?"
assert_contains "machine init" "initialized \"ci-verify\"" "$(last_stdout)"
start_daemon
run_machine status || fail "machine status exited with status $?"
assert_contains "machine status" "ci-verify" "$(last_stdout)"
assert_contains "machine status" "version: $VERSION" "$(last_stdout)"
stop_daemon

step "(e) the package ships the app-module and 'machine cli register' defers it when app-core is not running"
PACKAGE_DIR="$(installed_package_dir)"
assert_file "the packaged manifest of the app-module" "$PACKAGE_DIR/app-module/manifest.json"
assert_contains "the packaged manifest of the app-module" "\"id\": \"machine\"" "$(cat "$PACKAGE_DIR/app-module/manifest.json")"
assert_contains "the packaged manifest of the app-module" "\"version\": \"$VERSION\"" "$(cat "$PACKAGE_DIR/app-module/manifest.json")"
assert_file "the updater bundle of the package" "$PACKAGE_DIR/machine-updater.cjs"
pick_free_port
run_machine cli register --json || fail "machine cli register exited with status $? (it must defer when app-core is not running)"
assert_contains "machine cli register" "not running, left" "$(last_stdout)"
# The copy app-core will load at its next start lives in the machine config folder: it must survive an update or removal of the npm folder.
assert_file "the staged copy of the app-module" "$MACHINE_CONFIG_DIR/app-module/$VERSION/manifest.json"
assert_file "the pending registration for app-core" "$APP_CORE_CONFIG_DIR/modules/machine.json"

echo
echo "verify-install: all steps passed for $VERSION on $(uname -s)"
