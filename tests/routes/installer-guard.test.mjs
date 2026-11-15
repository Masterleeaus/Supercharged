/**
 * Unit tests for the setup-token guard on POST /api/installer/install.
 * Run: node --test --experimental-transform-types tests/routes/installer-guard.test.mjs
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkInstallAllowed,
  installTokenMatches,
  INSTALL_SETUP_TOKEN_ENV,
  INSTALL_SETUP_TOKEN_HEADER,
} from '../../server/routes/installer-guard.ts';

const SECRET = 'test-setup-token-value-0123456789';
const notInstalled = async () => false;
const installed = async () => true;

describe('installer setup token guard', () => {
  test('header name is X-Install-Token and env name is INSTALL_SETUP_TOKEN', () => {
    assert.equal(INSTALL_SETUP_TOKEN_HEADER, 'X-Install-Token');
    assert.equal(INSTALL_SETUP_TOKEN_ENV, 'INSTALL_SETUP_TOKEN');
  });

  test('unset env var rejects with 403, even with a token header', async () => {
    const denial = await checkInstallAllowed({
      presentedToken: SECRET,
      isInstalled: notInstalled,
      env: {},
    });
    assert.equal(denial?.status, 403);
    assert.doesNotMatch(denial.message, new RegExp(SECRET));
  });

  test('empty or whitespace env var rejects with 403', async () => {
    for (const value of ['', '   ']) {
      const denial = await checkInstallAllowed({
        presentedToken: value,
        isInstalled: notInstalled,
        env: { [INSTALL_SETUP_TOKEN_ENV]: value },
      });
      assert.equal(denial?.status, 403, `value ${JSON.stringify(value)} should reject`);
    }
  });

  test('unset env var does not consult the installed check', async () => {
    let called = false;
    await checkInstallAllowed({
      presentedToken: SECRET,
      isInstalled: async () => {
        called = true;
        return false;
      },
      env: {},
    });
    assert.equal(called, false);
  });

  test('missing header rejects when env var is set', async () => {
    const denial = await checkInstallAllowed({
      presentedToken: undefined,
      isInstalled: notInstalled,
      env: { [INSTALL_SETUP_TOKEN_ENV]: SECRET },
    });
    assert.equal(denial?.status, 403);
  });

  test('wrong token rejects with 403', async () => {
    const denial = await checkInstallAllowed({
      presentedToken: 'wrong-token',
      isInstalled: notInstalled,
      env: { [INSTALL_SETUP_TOKEN_ENV]: SECRET },
    });
    assert.equal(denial?.status, 403);
    assert.doesNotMatch(denial.message, new RegExp(SECRET));
  });

  test('token that is a prefix of the real token rejects', async () => {
    const denial = await checkInstallAllowed({
      presentedToken: SECRET.slice(0, -1),
      isInstalled: notInstalled,
      env: { [INSTALL_SETUP_TOKEN_ENV]: SECRET },
    });
    assert.equal(denial?.status, 403);
  });

  test('correct token on a not-yet-installed server allows the request', async () => {
    const denial = await checkInstallAllowed({
      presentedToken: SECRET,
      isInstalled: notInstalled,
      env: { [INSTALL_SETUP_TOKEN_ENV]: SECRET },
    });
    assert.equal(denial, null);
  });

  test('correct token on an already-installed server is still rejected', async () => {
    const denial = await checkInstallAllowed({
      presentedToken: SECRET,
      isInstalled: installed,
      env: { [INSTALL_SETUP_TOKEN_ENV]: SECRET },
    });
    assert.equal(denial?.status, 403);
    assert.equal(denial.message, 'Application is already installed');
  });

  test('installTokenMatches is exact and handles unequal lengths', () => {
    assert.equal(installTokenMatches(SECRET, SECRET), true);
    assert.equal(installTokenMatches(SECRET + 'x', SECRET), false);
    assert.equal(installTokenMatches('', SECRET), false);
  });
});
