#!/usr/bin/env bash
# Smoke test of the PACKED CLI on the machine it runs on (CI: macOS and Linux runners). Nothing is published and the real
# global npm is never touched: the wrapper and the platform package of this host are `npm pack`ed, installed into a throwaway
# prefix, and run from there, with a throwaway MACHINE_CONFIG_DIR and home.
# Fails loudly (full output) when a tarball loses the exec bit, or a command exits non-zero, prints nothing on stdout, or does not
# show the version. Registry errors on stderr are expected (the registry is a dead loopback port) and are not asserted on.
#
# Usage: bash smoke-packed.sh <packages dir> <cli> <expected version> <platforms>
#   <packages dir>  holds <cli>-cli-dist and <cli>-cli-<platform> (the build job's artifact, exec bits restored by restore-exec-bits.sh).
#   <cli>           machine
#   <expected version>  the build version (CalVer): what `machine --version` must print. The platform package has its own hash-reuse
#                   version (<build>-bin.<hash>); the wrapper is pinned to it in a COPY, the way publish-platform-packages.mjs pins it.
#   <platforms>     the same comma list as the platform packages of the artifact; the host must be one of them.
# Run locally: Linux, macOS (or git-bash on Windows, where the exec-bit check is skipped: modes mean nothing there), node >= 24,
#              after `generate-platform-packages.mjs --out <dir> --version <CalVer>`.
set -euo pipefail

USAGE="usage: smoke-packed.sh <packages dir> <cli> <expected version> <platforms>"
PACKAGES_DIR="${1:?$USAGE}"
CLI="${2:?$USAGE}"
VERSION="${3:?$USAGE}"
PLATFORMS="${4:?$USAGE}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WINDOWS_HOST=0
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  PLATFORM="darwin-arm64" ;;
  Linux-x86_64)  PLATFORM="linux-x64" ;;
  MINGW*-x86_64 | MSYS*-x86_64) PLATFORM="win32-x64"; WINDOWS_HOST=1 ;;
  *) echo "smoke-packed: unsupported host $(uname -s)-$(uname -m): this script runs on macOS (darwin-arm64) or Linux (linux-x64), and on Windows (git-bash, local rehearsal only)" >&2; exit 1 ;;
esac
case ",$PLATFORMS," in
  *",$PLATFORM,"*) ;;
  *) echo "smoke-packed: host platform $PLATFORM is not in PLATFORMS='$PLATFORMS': run it on a supported runner" >&2; exit 1 ;;
esac

for pkg in "${CLI}-cli-dist" "${CLI}-cli-$PLATFORM"; do
  [ -d "$PACKAGES_DIR/$pkg" ] || { echo "smoke-packed: $PACKAGES_DIR/$pkg is missing (artifact incomplete)" >&2; exit 1; }
done

WORK="$(mktemp -d)"
# The throwaway directory must never turn a green smoke red: a failed cleanup is a warning, and never changes the exit code of the checks
# (task run 43522571279: every check passed, the script exited 1 on a "Directory not empty" alone).
cleanup() {
  local code=$?
  rm -rf "$WORK" 2>/dev/null || { sleep 2; rm -rf "$WORK" 2>/dev/null; } || echo "smoke-packed: warning: could not remove $WORK" >&2
  exit "$code"
}
trap cleanup EXIT
TGZ="$WORK/tgz"
PREFIX="$WORK/prefix"
HOME_DIR="$WORK/home"
CONFIG_DIR="$WORK/machine-config"
mkdir -p "$TGZ" "$PREFIX" "$HOME_DIR/.config" "$CONFIG_DIR"

# Pin the wrapper to the version of the platform package, in a copy: the artifact stays as built (publish pins it for real).
# The first "version" key of the generated package.json (2-space JSON written by packagesWriter): the top-level one.
PLATFORM_VERSION="$(sed -n 's/^  "version": "\([^"]*\)",\{0,1\}$/\1/p' "$PACKAGES_DIR/${CLI}-cli-$PLATFORM/package.json" | head -n 1)"
[ -n "$PLATFORM_VERSION" ] || { echo "smoke-packed: no \"version\" in $PACKAGES_DIR/${CLI}-cli-$PLATFORM/package.json" >&2; exit 1; }
cp -R "$PACKAGES_DIR/${CLI}-cli-dist" "$WORK/wrapper"
node "$SCRIPT_DIR/pin-platform-versions.mjs" --wrapper "$WORK/wrapper" --version "$PLATFORM_VERSION"
(cd "$WORK/wrapper" && npm pack --silent --pack-destination "$TGZ" >/dev/null)
(cd "$PACKAGES_DIR/${CLI}-cli-$PLATFORM" && npm pack --silent --pack-destination "$TGZ" >/dev/null)

# The published tarball must carry the exec bit on the launcher and the shim: this is the regression being guarded.
echo "--- tarball entries (mode, size, name)"
failures=0
for t in "$TGZ"/*.tgz; do
  echo "$(basename "$t")"
  entries="$(tar -tvzf "$t" | grep -E "package/(${CLI}|bin/${CLI}\.js)$" || true)"
  echo "$entries"
  if [ "$WINDOWS_HOST" = 1 ]; then
    continue
  fi
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if [[ "${line:0:10}" != *x*x*x* ]]; then
      failures=$((failures + 1))
      echo "FAIL tarball entry without the exec bit: $line (restore-exec-bits.sh was not run, or npm pack dropped it)" >&2
    fi
  done <<< "$entries"
done
if [ "$WINDOWS_HOST" = 1 ]; then
  echo "smoke-packed: exec bits are not checked on a Windows host (local rehearsal only): the CI runs this on macOS and Linux"
fi

# Throwaway npm, config folder and home: no real config, no real registry (nothing of the CLI may find one either).
export HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" USERPROFILE="$HOME_DIR" MACHINE_CONFIG_DIR="$CONFIG_DIR"
export NPM_CONFIG_PREFIX="$PREFIX" NPM_CONFIG_CACHE="$WORK/npm-cache" NPM_CONFIG_USERCONFIG="$WORK/npmrc"
export NPM_CONFIG_REGISTRY="http://127.0.0.1:9/"
printf 'registry=http://127.0.0.1:9/\n@wadeck-app:registry=http://127.0.0.1:9/\nfetch-retries=0\nfetch-timeout=3000\n' > "$WORK/npmrc"
echo "autoUpdate: false" > "$CONFIG_DIR/config.yml"
# Away from the repository: a project .npmrc there could name the real registry.
cd "$WORK"

# Both tarballs are installed explicitly: the pinned platform package is not on any registry here.
npm install -g --prefix "$PREFIX" --omit=optional --no-audit --no-fund "$TGZ"/wadeck-app-"${CLI}"-cli-*.tgz

if [ "$WINDOWS_HOST" = 1 ]; then
  BIN="$PREFIX/$CLI"
  NODE_MODULES="$PREFIX/node_modules"
else
  BIN="$PREFIX/bin/$CLI"
  NODE_MODULES="$PREFIX/lib/node_modules"
fi
[ -e "$BIN" ] || { echo "smoke-packed: $BIN was not created by the install" >&2; exit 1; }
DIST_JSON="$NODE_MODULES/@wadeck-app/${CLI}-cli/package.json"
[ -f "$DIST_JSON" ] || { echo "smoke-packed: $DIST_JSON not found" >&2; exit 1; }
# --omit=optional hides a dependency problem a real install has: the wrapper must pin the exact platform package it ships with.
if ! grep -q "\"@wadeck-app/${CLI}-cli-$PLATFORM\": \"$PLATFORM_VERSION\"" "$DIST_JSON"; then
  echo "smoke-packed: optionalDependencies of $DIST_JSON do not pin @wadeck-app/${CLI}-cli-$PLATFORM to $PLATFORM_VERSION:" >&2
  grep -n "optionalDependencies" -A5 "$DIST_JSON" >&2 || true
  exit 1
fi
if grep -q '"latest"' "$DIST_JSON"; then
  echo "smoke-packed: $DIST_JSON still has a \"latest\" placeholder after the pin" >&2
  exit 1
fi
PLATFORM_DIR="$NODE_MODULES/@wadeck-app/${CLI}-cli-$PLATFORM"
[ -d "$PLATFORM_DIR" ] || { echo "smoke-packed: platform package $PLATFORM_DIR not installed" >&2; exit 1; }
echo "--- installed launcher"
ls -l "$PLATFORM_DIR"
file "$PLATFORM_DIR/$CLI"* || true

# check <label> <output must contain (may be empty)> <args...>: exit 0, non-empty stdout, containing the needle.
# check_fails <label> <output must contain> <args...>: exit non-zero, stdout and stderr together containing the needle.
check() {
  local label="$1" needle="$2"
  shift 2
  local out err code
  err="$WORK/stderr"
  set +e
  out="$("$BIN" "$@" 2> "$err")"
  code=$?
  set -e
  if [ "$code" -ne 0 ] || [ -z "$out" ] || { [ -n "$needle" ] && [[ "$out" != *"$needle"* ]]; }; then
    failures=$((failures + 1))
    echo "FAIL [$label] $CLI $* -> exit $code, stdout (${#out} chars):" >&2
    echo "$out" >&2
    echo "--- stderr:" >&2
    cat "$err" >&2
  else
    echo "ok   [$label] $CLI $* -> exit 0, ${#out} chars"
  fi
}

check_fails() {
  local label="$1" needle="$2"
  shift 2
  local out err code
  err="$WORK/stderr"
  set +e
  out="$("$BIN" "$@" 2> "$err")"
  code=$?
  set -e
  out="$out$(cat "$err")"
  if [ "$code" -eq 0 ] || [[ "$out" != *"$needle"* ]]; then
    failures=$((failures + 1))
    echo "FAIL [$label] $CLI $* should exit non-zero and mention '$needle' -> exit $code, output:" >&2
    echo "$out" >&2
  else
    echo "ok   [$label] $CLI $* -> exit $code and mentions '$needle'"
  fi
}

# The packed bundle is a release build: self-check judges the install as a user would have it (updater, app-module, pinned platform package).
run_all() {
  local label="$1"
  check "$label" "$VERSION" --version
  check "$label" "" --help
}

run_all "platform package present"
check "platform package present" "[ok] platform-package" cli self-check
check "platform package present" "[ok] app-module" cli self-check
check "platform package present" "[ok] updater-bundle" cli self-check

# The platform package (Go launcher) is only needed by `startup enable`: without it every other command must still work, the shim must not
# go installing it behind the user's back, and self-check must say it is missing (npm skips a failing optional dependency in silence).
rm -rf "$PLATFORM_DIR"
run_all "platform package absent"
check_fails "platform package absent" "platform-package" cli self-check
if [ -e "$PLATFORM_DIR" ]; then
  failures=$((failures + 1))
  echo "FAIL [platform package absent] $PLATFORM_DIR was recreated: a command installed it" >&2
fi

if [ "$failures" -ne 0 ]; then
  echo "smoke-packed: $failures check(s) failed" >&2
  exit 1
fi
echo "smoke-packed: all checks passed on $(uname -s)-$(uname -m) (version $VERSION, platform package $PLATFORM_VERSION)"
