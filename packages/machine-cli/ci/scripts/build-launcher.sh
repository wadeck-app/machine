#!/usr/bin/env bash
# Builds the Go launcher of machine with the SDK's build.sh (singleton-daemon-kit), cross-compiled with CGO off.
#
# Usage: bash ci/scripts/build-launcher.sh [--out <dir>] [--platforms <list>]
#   --out <dir>          default: packages/machine-cli/dist-launcher
#   --platforms <list>   comma separated, default: win32-x64,darwin-arm64,linux-x64
#
# Output: <out>/<platform>/machine.exe (win32-x64) or <out>/<platform>/machine, the file names of the platform packages
# (packaging.md, 3.1). The exec bit of the Unix files comes from `go build`; whatever copies them later must keep it
# (packaging.md, 1.4).
#
# Windows: the SDK links the exe with -H windowsgui (no console, so that the daemon started by orch never flashes a
# window; go-launcher/cmdflags_windows.go explains why node is then started with CREATE_NO_WINDOW). The SDK builds no
# console variant: one exe serves the daemon and, when stdout is a pipe or a file, the other commands too. In an
# interactive terminal a GUI exe prints nothing: the CLI commands of a terminal go through the npm shim (`node machine.cjs`),
# not through this exe (packaging.md, 3.3 "Shim").
#
# The SDK's build.sh always builds 5 targets. To build only the requested ones this script runs a patched COPY of it
# (target list swapped, SCRIPT_DIR pinned) and fails loudly when build.sh no longer has the expected shape.
# Windows PE metadata: build.sh warns when `goversioninfo` is not in PATH; LAUNCHER_REQUIRE_PE_METADATA=1 makes that an error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_DIR="$(cd "$CI_DIR/.." && pwd)"

fail() {
  echo "[fail] $*" >&2
  exit 1
}

# Path in the form the native tools understand: C:/x under Git Bash on Windows (node and go.exe cannot read /c/x), unchanged elsewhere.
native_path() {
  (cd "$1" && { pwd -W 2>/dev/null || pwd; })
}

OUT_DIR="$PACKAGE_DIR/dist-launcher"
PLATFORMS="win32-x64,darwin-arm64,linux-x64"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      [[ $# -ge 2 && "$2" != --* ]] || fail "--out needs a directory"
      OUT_DIR="$2"
      shift 2
      ;;
    --platforms)
      [[ $# -ge 2 && "$2" != --* ]] || fail "--platforms needs a list such as win32-x64,linux-x64"
      PLATFORMS="$2"
      shift 2
      ;;
    *)
      fail "unknown argument \"$1\": usage: build-launcher.sh [--out <dir>] [--platforms <list>]"
      ;;
  esac
done

# Platform key -> "<goos> <goarch> <file name of the SDK output> <file name in the platform package>".
platform_spec() {
  case "$1" in
    win32-x64) echo "windows amd64 machine_windows_release.exe machine.exe" ;;
    darwin-arm64) echo "darwin arm64 machine_darwin_arm64_release machine" ;;
    linux-x64) echo "linux amd64 machine_linux_amd64_release machine" ;;
    *) return 1 ;;
  esac
}

IFS=',' read -r -a WANTED <<< "$PLATFORMS"
[[ ${#WANTED[@]} -gt 0 ]] || fail "--platforms is empty"
for p in "${WANTED[@]}"; do
  platform_spec "$p" > /dev/null || fail "unsupported platform \"$p\": supported are win32-x64, darwin-arm64, linux-x64 (packaging.md, 3.1)"
done

command -v go > /dev/null || fail "'go' not found in PATH: install Go (the CI pins a patch version) and retry"
command -v node > /dev/null || fail "'node' not found in PATH: the SDK's build.sh uses it to read the config"

# The SDK is a dependency of machine-cli: look it up from here upwards (npm hoists it to the repository root).
KIT_GO=""
dir="$PACKAGE_DIR"
while true; do
  if [[ -f "$dir/node_modules/@wadeck-app/singleton-daemon-kit/go-launcher/build.sh" ]]; then
    KIT_GO="$dir/node_modules/@wadeck-app/singleton-daemon-kit/go-launcher"
    break
  fi
  parent="$(dirname "$dir")"
  [[ "$parent" != "$dir" ]] || break
  dir="$parent"
done
[[ -n "$KIT_GO" ]] || fail "@wadeck-app/singleton-daemon-kit/go-launcher/build.sh not found above $PACKAGE_DIR: run npm ci at the repository root"

BUILD_SH="$KIT_GO/build.sh"
for f in "$CI_DIR/launcher.config.json" "$CI_DIR/launcher-main.go.tmpl"; do
  [[ -f "$f" ]] || fail "launcher input not found: $f"
done

# build.sh of singleton-daemon-kit >= 2026.10.31-103-6ab86e9c: 5 build_target calls and one SCRIPT_DIR line.
EXPECTED_BUILD_TARGETS=5
found_targets="$(grep -c '^build_target "' "$BUILD_SH" || true)"
found_script_dir="$(grep -c '^SCRIPT_DIR=' "$BUILD_SH" || true)"
if [[ "$found_targets" != "$EXPECTED_BUILD_TARGETS" || "$found_script_dir" != "1" ]]; then
  fail "$BUILD_SH changed shape ($EXPECTED_BUILD_TARGETS build_target calls and one SCRIPT_DIR line expected, found $found_targets and $found_script_dir): update this script"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
WORK_NATIVE="$(native_path "$WORK")"
KIT_GO_NATIVE="$(native_path "$KIT_GO")"
CI_NATIVE="$(native_path "$CI_DIR")"

targets=""
for p in "${WANTED[@]}"; do
  read -r goos goarch sdk_name _ <<< "$(platform_spec "$p")"
  targets+="build_target \"$goos\" \"$goarch\" \"\$OUTPUT_DIR/$sdk_name\""$'\n'
done

# Patched copy: the first build_target call is replaced by the wanted ones, the others are dropped; SCRIPT_DIR points at the SDK.
awk -v targets="$targets" -v kit="$KIT_GO_NATIVE" '
  /^SCRIPT_DIR=/ { print "SCRIPT_DIR=\"" kit "\""; next }
  /^build_target "/ { if (!done) { printf "%s", targets; done = 1 } next }
  { print }
' "$BUILD_SH" > "$WORK/build-patched.sh"

mkdir -p "$WORK/sdk-out"
echo "Building the machine launcher for: $PLATFORMS"
bash "$WORK_NATIVE/build-patched.sh" "$CI_NATIVE/launcher.config.json" "$WORK_NATIVE/sdk-out" "$CI_NATIVE/launcher-main.go.tmpl"

mkdir -p "$OUT_DIR"
for p in "${WANTED[@]}"; do
  read -r _ _ sdk_name final_name <<< "$(platform_spec "$p")"
  [[ -f "$WORK/sdk-out/$sdk_name" ]] || fail "the SDK build did not produce $sdk_name for $p"
  mkdir -p "$OUT_DIR/$p"
  cp -p "$WORK/sdk-out/$sdk_name" "$OUT_DIR/$p/$final_name"
  echo "[ok] $OUT_DIR/$p/$final_name"
done
