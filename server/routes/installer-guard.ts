import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Guard for POST /api/installer/install.
 *
 * The install route is public (no login exists yet), so it must be gated by
 * a setup token the operator sets in the environment before the first install.
 * The token is never logged or returned.
 */

export const INSTALL_SETUP_TOKEN_ENV = 'INSTALL_SETUP_TOKEN';
export const INSTALL_SETUP_TOKEN_HEADER = 'X-Install-Token';

export interface InstallGuardDenial {
  status: 403;
  message: string;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Compares two strings in constant time. Both sides are hashed first so the
 * comparison always runs on equal-length buffers and does not leak length.
 */
export function installTokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/**
 * Returns a denial when the install request must be refused, or null when it
 * may proceed. Order matters: the token is checked before the installed-state
 * lookup so unauthenticated callers learn nothing about the install state.
 */
export async function checkInstallAllowed(options: {
  presentedToken: string | undefined;
  isInstalled: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallGuardDenial | null> {
  const env = options.env ?? process.env;
  const expected = env[INSTALL_SETUP_TOKEN_ENV];

  if (!expected || expected.trim() === '') {
    return { status: 403, message: 'Installation is disabled until INSTALL_SETUP_TOKEN is configured' };
  }

  if (!installTokenMatches(options.presentedToken ?? '', expected)) {
    return { status: 403, message: 'A valid install setup token is required' };
  }

  if (await options.isInstalled()) {
    return { status: 403, message: 'Application is already installed' };
  }

  return null;
}
