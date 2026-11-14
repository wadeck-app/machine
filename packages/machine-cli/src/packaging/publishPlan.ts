import { createHash } from 'node:crypto';
import { PLATFORM_TARGETS } from '../platformBinary.ts';
import { assertExactVersion, platformKeys } from './platformPackages.ts';

// Hash-reuse publishing (decision D29): the platform package version is `<build>-bin.<hash of all launcher bytes>`;
// an unchanged launcher keeps the already published version, so an update does not re-stage the exe nor restart the job.

const HASH_LENGTH = 12;

/** Hash over every platform launcher, in table order, with key and size so that moving bytes between platforms changes it. */
export function contentHash(binaries: Record<string, Uint8Array>): string {
  for (const key of Object.keys(binaries)) {
    if (!(key in PLATFORM_TARGETS)) {
      throw new Error(`unexpected launcher "${key}": not in the platform table (${platformKeys().join(', ')})`);
    }
  }
  const hash = createHash('sha256');
  for (const key of platformKeys()) {
    const bytes = binaries[key];
    if (bytes === undefined) {
      throw new Error(`no launcher for ${key}: build it first (ci/scripts/build-launcher.sh --platforms ${platformKeys().join(',')})`);
    }
    if (bytes.length === 0) {
      throw new Error(`the launcher for ${key} is empty: rebuild it (ci/scripts/build-launcher.sh)`);
    }
    hash.update(`${key}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest('hex').slice(0, HASH_LENGTH);
}

export function platformVersion(buildVersion: string, hash: string): string {
  assertExactVersion(buildVersion, 'build version');
  if (!new RegExp(`^[0-9a-f]{${HASH_LENGTH}}$`).test(hash)) {
    throw new Error(`content hash "${hash}" is not ${HASH_LENGTH} lowercase hex characters`);
  }
  return `${buildVersion}-bin.${hash}`;
}

export interface PublishPlan {
  version: string;
  /** reuse: a published version carries this hash; publish: none does, publish `version`. */
  action: 'reuse' | 'publish';
}

/**
 * `published` = versions of ONE platform package already on the registry. When some end with `-bin.<hash>`, the newest
 * is reused (same bytes); otherwise `<build>-bin.<hash>` is to be published.
 * The caller must run requireAllPublished before pinning a reused version.
 */
export function planPublish(buildVersion: string, hash: string, published: readonly string[]): PublishPlan {
  const fresh = platformVersion(buildVersion, hash);
  const suffix = `-bin.${hash}`;
  const matching = published.filter((v) => v.endsWith(suffix));
  if (matching.length === 0) return { version: fresh, action: 'publish' };
  // CalVer is zero padded and date ordered: the last one in lexicographic order is the newest.
  return { version: [...matching].sort().at(-1) as string, action: 'reuse' };
}

/** A reused version must exist for every platform package, else a half published set would be pinned. */
export function requireAllPublished(version: string, publishedByPackage: Record<string, readonly string[]>): void {
  const missing = Object.entries(publishedByPackage).filter(([, versions]) => !versions.includes(version)).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`${version} is not published for ${missing.join(', ')}: a previous publish was interrupted; publish the missing package(s) at exactly ${version} (npm publish in their folder) and retry`);
  }
}
