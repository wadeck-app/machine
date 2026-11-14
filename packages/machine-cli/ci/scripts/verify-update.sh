#!/usr/bin/env bash
# Verifies, in an isolated temp environment, the real update path: the PREVIOUS published version updates itself to <version>
# (while its daemon runs), rolls back, and updates again.
#
# Usage:       bash packages/machine-cli/ci/scripts/verify-update.sh <version>
# Run locally: same requirements as verify-install.sh. The previous version is taken from the registry
#              (npm view @wadeck-app/machine-cli versions --json), see previous-version.mjs. Skipped, with a log line, when there is none.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/verify-lib.sh"

VERSION="${1:-}"
[ -n "$VERSION" ] || fail "usage: verify-update.sh <version>"
PACKAGE="@wadeck-app/machine-cli"

isolate_env
trap cleanup_daemon EXIT

step "(e0) find the version published before $VERSION"
VERSIONS=""
for attempt in 1 2 3 4; do
  status=0
  VERSIONS="$(npm view "$PACKAGE" versions --json 2> "$(last_stderr_file)")" || status=$?
  if [ "$status" -eq 0 ]; then
    break
  fi
  echo "npm view $PACKAGE versions failed (attempt $attempt of 4), retrying in 10 s"
  cat "$(last_stderr_file)" >&2
  sleep 10
done
[ "$status" -eq 0 ] || fail "npm view $PACKAGE versions --json did not succeed after 4 attempts"
PREVIOUS="$(printf '%s' "$VERSIONS" | node "$SCRIPT_DIR/previous-version.mjs" "$VERSION" | tr -d '\r')"
if [ -z "$PREVIOUS" ]; then
  echo "SKIPPED: there is no version published before $VERSION, nothing to update from (first publication)"
  exit 0
fi
echo "previous version: $PREVIOUS"

step "(e1) npm install -g $PACKAGE@$PREVIOUS, then start its daemon"
install_global "$PACKAGE@$PREVIOUS"
ACTUAL="$(installed_version)"
assert_equals "installed version" "$PREVIOUS" "$ACTUAL"
run_machine init --name ci-verify || fail "machine init exited with status $?"
start_daemon

step "(e2) machine cli update installs $VERSION while the daemon of $PREVIOUS runs"
update_to "$VERSION"
run_machine cli self-check || fail "machine cli self-check exited with status $?"
echo "ok: self-check of the updated install passed"

# Without a startup job nothing would relaunch a daemon that post-update stops, so it keeps running the previous version
# (the update says so: "A daemon you started by hand keeps running the previous version until you restart it").
step "(e2b) no startup job: the daemon of $PREVIOUS keeps running, and a restart runs $VERSION"
run_machine status || fail "machine status exited with status $?"
assert_contains "machine status after the update (the daemon still runs the previous version)" "$PREVIOUS" "$(last_stdout)"
run_machine stop || fail "machine stop exited with status $?"
assert_contains "machine stop after the update" "daemon stopped" "$(last_stdout)"
start_daemon
run_machine status || fail "machine status exited with status $?"
assert_contains "machine status after the restart (the daemon runs the updated version)" "$VERSION" "$(last_stdout)"

step "(e2c) the updated package ships the app-module and registers it (deferred: app-core is not running)"
assert_file "the packaged manifest of the app-module" "$(installed_package_dir)/app-module/manifest.json"
pick_free_port
run_machine cli register --json || fail "machine cli register exited with status $?"
assert_contains "machine cli register" "not running, left" "$(last_stdout)"
assert_file "the staged copy of the app-module" "$MACHINE_CONFIG_DIR/app-module/$VERSION/manifest.json"

step "(e3) machine cli rollback puts $PREVIOUS back"
run_machine cli rollback || fail "machine cli rollback exited with status $?"
ACTUAL="$(installed_version)"
assert_equals "installed version after the rollback" "$PREVIOUS" "$ACTUAL"

step "(e4) machine cli update installs $VERSION again"
update_to "$VERSION"
run_machine cli self-check || fail "machine cli self-check exited with status $?"
echo "ok: self-check passed after the second update"

echo
echo "verify-update: all steps passed ($PREVIOUS -> $VERSION -> $PREVIOUS -> $VERSION) on $(uname -s)"
