#!/usr/bin/env node
'use strict';
// Shim of @wadeck-app/machine-cli (bin "machine"): checks the platform and the bundle, then runs `node machine.cjs <args>`
// with inherited stdio (passphrase prompts and `--json` pipes need it). The launcher is never run from here: orch runs it.

// Must equal PLATFORM_TARGETS in src/platformBinary.ts (src/packaging/shim.test.ts checks it).
const SUPPORTED = ['win32-x64', 'darwin-arm64', 'linux-x64'];

function platformKey(platform, arch) {
  return platform + '-' + (arch === 'arm64' ? 'arm64' : 'x64');
}

/**
 * deps: { platform, arch, argv (args after the script), execPath, bundlePath, exists(path), spawnSync(cmd, args, opts), stderr(text) }
 * Returns the exit code.
 */
function run(deps) {
  const key = platformKey(deps.platform, deps.arch);
  if (!SUPPORTED.includes(key)) {
    deps.stderr('[fail] machine does not support ' + key + ' (supported: ' + SUPPORTED.join(', ') + '). Run it on a supported machine.\n');
    return 1;
  }
  if (!deps.exists(deps.bundlePath)) {
    deps.stderr('[fail] ' + deps.bundlePath + ' is missing: the installation is incomplete. Reinstall: npm i -g @wadeck-app/machine-cli\n');
    return 1;
  }
  const result = deps.spawnSync(deps.execPath, [deps.bundlePath, ...deps.argv], { stdio: 'inherit' });
  if (result.error) {
    deps.stderr('[fail] cannot start node (' + result.error.message + '): install Node.js 24 or newer and put it on PATH.\n');
    return 1;
  }
  if (result.status === null) {
    deps.stderr('[fail] machine was stopped by signal ' + result.signal + '.\n');
    return 1;
  }
  return result.status;
}

module.exports = { run, SUPPORTED, platformKey };

if (require.main === module) {
  const path = require('node:path');
  const fs = require('node:fs');
  process.exitCode = run({
    platform: process.platform,
    arch: process.arch,
    argv: process.argv.slice(2),
    execPath: process.execPath,
    bundlePath: path.join(__dirname, '..', 'machine.cjs'),
    exists: fs.existsSync,
    spawnSync: require('node:child_process').spawnSync,
    stderr: (text) => process.stderr.write(text),
  });
}
