import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { describe, expect, it } from 'vitest';
import { resolveModuleConfigDir, SECRETS_DIRNAME } from './configDir.js';

describe('resolveModuleConfigDir', () => {
  it('uses MACHINE_CONFIG_DIR when it is set (same resolution as machine-cli paths.ts)', () => {
    expect(resolveModuleConfigDir({ MACHINE_CONFIG_DIR: '/some/where' })).toBe('/some/where');
  });

  it('ignores an empty MACHINE_CONFIG_DIR and falls back to the shared default', () => {
    expect(resolveModuleConfigDir({ MACHINE_CONFIG_DIR: '' })).toBe(ConfigDir.get('machine'));
  });

  it('falls back to the shared default (~/.config/machine) without the variable', () => {
    expect(resolveModuleConfigDir({})).toBe(ConfigDir.get('machine'));
  });

  it('names the secrets folder like machine-cli does', () => {
    expect(SECRETS_DIRNAME).toBe('_secrets_');
  });
});
