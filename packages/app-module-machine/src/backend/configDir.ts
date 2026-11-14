import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';

// Copy of the resolution of machine-cli paths.ts (machine-cli exports neither `resolveConfigDir` nor `SECRETS_DIRNAME`
// and this module must not widen it): MACHINE_CONFIG_DIR, then the shared default (~/.config/machine).
// There is no `--config-dir` here: app-core starts this module, nobody passes it a flag.

export const SECRETS_DIRNAME = '_secrets_';

export function resolveModuleConfigDir(env: Record<string, string | undefined>): string {
  const fromEnv = env['MACHINE_CONFIG_DIR'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return ConfigDir.get('machine');
}
