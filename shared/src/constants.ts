export const QUACK_VERSION = '0.2.3';

/**
 * Wire protocol version. Increment only on breaking changes between extension
 * and companion; product releases can increment QUACK_VERSION independently.
 */
export const PROTOCOL_VERSION = 1;

export const HOST_NAME = 'com.quack.companion';

/**
 * Deterministic extension ID derived from EXTENSION_PUBLIC_KEY. Used by
 * unpacked development builds so the ID matches the native host allowlist.
 */
export const DEV_EXTENSION_ID = 'ikkjkdmcnmifldjmajjjgabanjomhikf';

/**
 * Chrome Web Store extension ID. Populate after initial store upload and
 * reinstall the companion to allow connections from store builds.
 */
export const STORE_EXTENSION_ID = 'hkdgklakkcffcmegdagdoigpaefhlipj';

/** Valid 32-char Chrome extension IDs permitted in the native host manifest. */
export const ALLOWED_EXTENSION_IDS = [DEV_EXTENSION_ID, STORE_EXTENSION_ID].filter((id) => /^[a-p]{32}$/.test(id));

export const EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApVYYi5PKvrC1/VsptdSD87Sqz71DX769+oWNQ+04MpvHCDfmKVOc3DUBLeo1zL/oyEEQ/bWZHUZEkKWfIV2GNZ38v6+5zq0qoeVCEod/fRojzWHWZH5enU2DIHgChqas1dXTXLUHVzsaVr7w0VGm1bY9KCCZVLnlx/kNncWoBAoORmCPRlR4ab5VPGYVFucUzCiTX7FNIAn1N8/7q72lgHX2dtAQroxGbYhSRqF5Z8H2KimxVHzJRfzwYcCXI0UyPQfJvxgVCMjidHfEzsGaC9msyeCJXNMMYrywPQSUcM3mj1autpeiT9RXMo/u1Q5cJzILHg04to6uCB9pNolOFwIDAQAB';

export const AGENT_TIMEOUT_MS = 5 * 60 * 1000;

/** Public GitHub repository whose Releases serve `install.sh` and `quack-companion.cjs`. */
export const COMPANION_REPO = 'oicramps/quack';

export const CHROME_STORE_URL = `https://chromewebstore.google.com/detail/quack/${STORE_EXTENSION_ID}`;

export const INSTALL_COMMAND = 'npx quack-companion@latest install';

/** True when dotted version `a` is lower than `b`. Unparseable parts count as 0. */
export function isOlderVersion(a: string, b: string): boolean {
  const parse = (v: string) => v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}
