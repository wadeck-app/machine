#!/usr/bin/env bash
# Shared helpers of verify-install.sh and verify-update.sh. Sourced, never run.
# Run locally: see the header of verify-install.sh (needs bash, node, npm and a token with read:packages in your npm config).

# --- output ---------------------------------------------------------------------------------------------------------

step() {
  echo
  echo "==> $*"
}

# A collapsible block in the GitHub log; plain separators elsewhere.
group_start() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::group::$*"
  else
    echo "--- $*"
  fi
}

group_end() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::endgroup::"
  fi
  return 0
}

# Where the output of the last `run_machine` (or npm install) is kept, for the checks and for the diagnosis of a failure.
last_stdout_file() { echo "${VERIFY_ROOT:-.}/last-stdout.txt"; }
last_stderr_file() { echo "${VERIFY_ROOT:-.}/last-stderr.txt"; }
last_stdout() { cat "$(last_stdout_file)" 2> /dev/null || true; }
last_stderr() { cat "$(last_stderr_file)" 2> /dev/null || true; }

# The last non-empty line of the stdout of the last command, without carriage returns.
last_line() {
  { tr -d '\r' < "$(last_stdout_file)" 2> /dev/null | grep -v '^[[:space:]]*$' | tail -n 1; } || true
}

# One GitHub annotation (readable through the check-runs API without access to the job log): the message and the last lines of the
# output of the failing command, newlines and percent signs encoded as workflow commands require, about 1500 characters at most.
annotate_error() {
  local text="$1" tail_out tail_err
  tail_out="$(tail -n 15 "$(last_stdout_file)" 2> /dev/null | tr -d '\r' || true)"
  tail_err="$(tail -n 15 "$(last_stderr_file)" 2> /dev/null | tr -d '\r' || true)"
  if [ -n "$tail_out" ]; then
    text="$text"$'\n'"--- last stdout:"$'\n'"$tail_out"
  fi
  if [ -n "$tail_err" ]; then
    text="$text"$'\n'"--- last stderr:"$'\n'"$tail_err"
  fi
  text="${text:0:1500}"
  text="${text//'%'/%25}"
  text="${text//$'\r'/%0D}"
  text="${text//$'\n'/%0A}"
  echo "::error title=verify-install::$text"
}

fail() {
  local message="FAIL: $*"
  echo "$message" >&2
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    annotate_error "$message"
  fi
  exit 1
}

# The platform package (the Go launcher) must come with the install: its optionalDependencies range must match the version
# (the range >=0.0.0-0 does not match a prerelease version, npm then silently installs none and only `start` would fetch it).
assert_platform_package_installed() {
  local listed
  listed="$(npm ls -g --all --parseable 2>/dev/null | grep -c 'machine-cli-\(win32\|darwin\|linux\)-' || true)"
  [ "$listed" -ge 1 ] || fail "no platform package (@wadeck-app/machine-cli-<os>-<cpu>) was installed with the CLI: check the optionalDependencies of the published main package"
  echo "ok: a platform package is installed ($listed)"
}

assert_equals() {
  local what="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    fail "$what: expected '$expected', got '$actual'"
  fi
  echo "ok: $what is '$actual'"
}

assert_contains() {
  local what="$1" needle="$2" text="$3"
  case "$text" in
    *"$needle"*) echo "ok: $what contains '$needle'" ;;
    *) fail "$what: expected it to contain '$needle', got: $text" ;;
  esac
}

# --- isolated environment -------------------------------------------------------------------------------------------

# A path the native node.exe understands too: C:/Users/... on Windows (git-bash), unchanged elsewhere.
native_path() {
  if command -v cygpath > /dev/null 2>&1; then
    cygpath -m "$1"
  else
    echo "$1"
  fi
}

# Everything the tests do happens in a temp folder: the global npm prefix, the machine config folder, the app-core config folder, the home.
# The automatic update is switched off so that a background update never races with the steps (`machine cli update` still works: it forces).
isolate_env() {
  # npm authentication must survive the redirection of HOME: setup-node sets NPM_CONFIG_USERCONFIG; for a local run, npm is asked where its
  # user config is before HOME moves. Nothing here reads or copies that file.
  if [ -z "${NPM_CONFIG_USERCONFIG:-}" ]; then
    local userconfig
    userconfig="$(npm config get userconfig 2> /dev/null || true)"
    if [ -n "$userconfig" ]; then
      export NPM_CONFIG_USERCONFIG="$userconfig"
    fi
  fi
  local root="${VERIFY_ROOT:-$(mktemp -d)}"
  mkdir -p "$root"
  root="$(native_path "$root")"
  export VERIFY_ROOT="$root"
  export npm_config_prefix="$root/npm-prefix"
  # Overwritten, never inherited: the config folder of the runner (or of the developer, locally) is never read or written.
  export MACHINE_CONFIG_DIR="$root/machine-config"
  export XDG_CONFIG_HOME="$root/xdg"
  export HOME="$root/home"
  export USERPROFILE="$root/home"
  # app-core's own config folder: `machine cli register` leaves its pending registration there when app-core is not running.
  export APP_CORE_CONFIG_DIR="$root/app-core"
  mkdir -p "$npm_config_prefix" "$XDG_CONFIG_HOME" "$MACHINE_CONFIG_DIR" "$HOME" "$APP_CORE_CONFIG_DIR"
  echo "autoUpdate: false" > "$MACHINE_CONFIG_DIR/config.yml"
  # The global bin folder: the prefix itself on Windows, <prefix>/bin elsewhere. In git-bash PATH is a list of POSIX paths separated by
  # colons: a C:/ entry would be cut at its colon.
  local bin_dir
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) bin_dir="$(cygpath -u "$npm_config_prefix")" ;;
    *) bin_dir="$npm_config_prefix/bin" ;;
  esac
  export PATH="$bin_dir:$PATH"
  echo "isolated environment in $root"
}

# --- running the CLI ------------------------------------------------------------------------------------------------

# The installed `machine` command (the bin shim of the global install) runs on every platform of the release: win32-x64, darwin-arm64, linux-x64.
machine() {
  command machine "$@"
}

# Runs `machine` with its stdout and stderr kept apart in files (never mixed in a value to compare), shows both in the log, and returns its status.
run_machine() {
  local status=0
  mkdir -p "${VERIFY_ROOT:-.}"
  machine "$@" > "$(last_stdout_file)" 2> "$(last_stderr_file)" || status=$?
  {
    echo "--- machine $* (exit $status)"
    cat "$(last_stdout_file)"
    if [ -s "$(last_stderr_file)" ]; then
      echo "--- stderr:"
      cat "$(last_stderr_file)"
    fi
  } >&2
  return $status
}

# The installed version: the last non-empty line of the stdout of `machine --version`.
installed_version() {
  local status=0
  run_machine --version || status=$?
  if [ "$status" -ne 0 ]; then
    fail "machine --version exited with status $status"
  fi
  last_line
}

# `machine cli update` until the installed version is the wanted one: right after a publish the registry may still serve the previous dist-tag.
update_to() {
  local want="$1" attempt status got=""
  for attempt in 1 2 3 4 5 6; do
    status=0
    run_machine cli update || status=$?
    if [ "$status" -ne 0 ]; then
      fail "machine cli update exited with status $status"
    fi
    got="$(installed_version)"
    if [ "$got" = "$want" ]; then
      echo "ok: installed version is '$got' (update attempt $attempt)"
      return 0
    fi
    echo "installed '$got', wanted '$want' (the registry may still serve the previous dist-tag), retrying in 15 s ($attempt of 6)"
    sleep 15
  done
  fail "after 6 attempts the installed version is '$got', expected '$want'"
}

# `npm install -g` of a version that was just published may fail for a few seconds (the registry has not indexed it yet).
install_global() {
  local spec="$1" attempt status
  mkdir -p "${VERIFY_ROOT:-.}"
  group_start "npm install -g $spec"
  for attempt in 1 2 3 4 5 6; do
    status=0
    npm install -g "$spec" > "$(last_stdout_file)" 2> "$(last_stderr_file)" || status=$?
    cat "$(last_stdout_file)"
    cat "$(last_stderr_file)" >&2
    if [ "$status" -eq 0 ]; then
      group_end
      return 0
    fi
    echo "npm install -g $spec failed (attempt $attempt of 6), retrying in 10 s"
    sleep 10
  done
  group_end
  fail "npm install -g $spec did not succeed after 6 attempts"
}

# --- the app-module -------------------------------------------------------------------------------------------------

VERIFY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The folder npm installed the package in.
installed_package_dir() {
  echo "$(npm root -g)/@wadeck-app/machine-cli"
}

assert_file() {
  local what="$1" file="$2"
  [ -f "$file" ] || fail "$what: the file $file does not exist"
  echo "ok: $what exists ($file)"
}

# A port where nothing listens, exported as APP_CORE_PORT: app-core is certainly "not running" for the next command.
pick_free_port() {
  local port
  port="$(node "$VERIFY_LIB_DIR/free-port.mjs")" || fail "cannot find a free port"
  export APP_CORE_PORT="$port"
  echo "app-core is not running: APP_CORE_PORT=$port (nothing listens there)"
}

# --- the daemon -----------------------------------------------------------------------------------------------------

DAEMON_PID=""

# The daemon runs in the background of the script, on two free loopback ports (never the default ones: another daemon may hold them), with its
# stdout and stderr in files. The peer listener binds 127.0.0.1 only: nothing here is reachable from the network.
start_daemon() {
  local api peer attempt
  api="$(node "$VERIFY_LIB_DIR/free-port.mjs")" || fail "cannot find a free port"
  peer="$api"
  while [ "$peer" = "$api" ]; do
    peer="$(node "$VERIFY_LIB_DIR/free-port.mjs")" || fail "cannot find a free port"
  done
  machine daemon --api-port "$api" --peer-port "$peer" --peer-host 127.0.0.1 > "$VERIFY_ROOT/daemon-stdout.txt" 2> "$VERIFY_ROOT/daemon-stderr.txt" &
  DAEMON_PID=$!
  for attempt in $(seq 1 60); do
    if grep -q 'local API' "$VERIFY_ROOT/daemon-stdout.txt" 2> /dev/null; then
      echo "ok: the daemon runs (api $api, peers $peer): $(tr -d '\r' < "$VERIFY_ROOT/daemon-stdout.txt" | head -n 1)"
      return 0
    fi
    if ! kill -0 "$DAEMON_PID" 2> /dev/null; then
      cp "$VERIFY_ROOT/daemon-stdout.txt" "$(last_stdout_file)"
      cp "$VERIFY_ROOT/daemon-stderr.txt" "$(last_stderr_file)"
      fail "the daemon exited before it was ready (its output is above and in the annotation)"
    fi
    sleep 1
  done
  cp "$VERIFY_ROOT/daemon-stdout.txt" "$(last_stdout_file)"
  cp "$VERIFY_ROOT/daemon-stderr.txt" "$(last_stderr_file)"
  fail "the daemon was not ready after 60 s"
}

# `machine stop` reaches the running daemon through the config folder: it also proves the CLI found THIS daemon.
stop_daemon() {
  run_machine stop || fail "machine stop exited with status $?"
  assert_contains "machine stop" "daemon stopped" "$(last_stdout)"
  local attempt
  for attempt in $(seq 1 20); do
    kill -0 "$DAEMON_PID" 2> /dev/null || return 0
    sleep 1
  done
  fail "the daemon process $DAEMON_PID is still alive 20 s after machine stop"
}

# After an update the daemon of the replaced version must be gone: the post-update step asks it to quit, and no startup job relaunches it here.
assert_daemon_gone() {
  run_machine stop || fail "machine stop exited with status $?"
  assert_contains "machine stop after the update" "daemon was not running" "$(last_stdout)"
}

# Best effort, for an EXIT trap: a failed step must not leave a daemon running on the runner or on the developer machine.
cleanup_daemon() {
  [ -n "$DAEMON_PID" ] || return 0
  machine stop > /dev/null 2>&1 || true
  if kill -0 "$DAEMON_PID" 2> /dev/null; then
    kill "$DAEMON_PID" > /dev/null 2>&1 || true
  fi
}
