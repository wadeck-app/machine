import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';

export const SECRETS_DIRNAME = '_secrets_';

/** `--config-dir` wins, then MACHINE_CONFIG_DIR (tests and unusual setups), then the shared default (~/.config/machine). */
export function resolveConfigDir(flag: string | undefined, env: Record<string, string | undefined>): string {
  if (flag !== undefined) {
    if (flag.length === 0) throw new Error('--config-dir needs a path');
    return flag;
  }
  const fromEnv = env.MACHINE_CONFIG_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return ConfigDir.get('machine');
}
