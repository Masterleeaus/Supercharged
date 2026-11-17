/**
 * Tests for server/routes/password-reset-binding.ts, the check behind POST /api/auth/forgot-password/reset.
 * Proves that a reset with only the email and a verified OTP row is refused, and that the normal flow
 * (verify-otp issues a token, reset presents it) is accepted.
 * auth-routes.ts itself is not loaded here: plain node cannot import it (express type-only imports).
 * Run: node --test --experimental-transform-types tests/routes/password-reset-binding.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashResetToken, issueResetToken, canResetWithToken, RESET_WINDOW_MS } from '../../server/routes/password-reset-binding.ts';

const now = new Date('2026-11-18T10:00:00Z');
const justVerified = new Date(now.getTime() - 60 * 1000);

// Simulates the row verify-otp leaves behind: verified=true and otpCode holding the token hash.
function verifiedRowFor(issued, verifiedAt = justVerified) {
  return { verified: true, otpCode: issued.hash, createdAt: verifiedAt };
}

test('normal flow: the token issued by verify-otp is accepted by reset', () => {
  const issued = issueResetToken();
  const row = verifiedRowFor(issued);
  assert.equal(canResetWithToken({ presentedToken: issued.token, storedHash: row.otpCode, verifiedAt: row.createdAt, now }), true);
});

test('refused: email plus verified OTP row with no token', () => {
  const issued = issueResetToken();
  const row = verifiedRowFor(issued);
  for (const presentedToken of [undefined, null, '', 0, {}]) {
    assert.equal(canResetWithToken({ presentedToken, storedHash: row.otpCode, verifiedAt: row.createdAt, now }), false);
  }
});

test('refused: wrong token', () => {
  const issued = issueResetToken();
  const row = verifiedRowFor(issued);
  assert.equal(canResetWithToken({ presentedToken: 'a'.repeat(64), storedHash: row.otpCode, verifiedAt: row.createdAt, now }), false);
});

test('refused: token from another verification of the same email', () => {
  const earlier = issueResetToken();
  const latest = issueResetToken();
  const row = verifiedRowFor(latest);
  assert.equal(canResetWithToken({ presentedToken: earlier.token, storedHash: row.otpCode, verifiedAt: row.createdAt, now }), false);
});

test('refused: legacy verified row still holding a plain OTP code (no stored hash match)', () => {
  const issued = issueResetToken();
  assert.equal(canResetWithToken({ presentedToken: '123456', storedHash: '123456', verifiedAt: justVerified, now }), false);
  assert.equal(canResetWithToken({ presentedToken: issued.token, storedHash: null, verifiedAt: justVerified, now }), false);
});

test('refused: token presented after the 10 minute window', () => {
  const issued = issueResetToken();
  const stale = new Date(now.getTime() - RESET_WINDOW_MS - 1000);
  const row = verifiedRowFor(issued, stale);
  assert.equal(canResetWithToken({ presentedToken: issued.token, storedHash: row.otpCode, verifiedAt: row.createdAt, now }), false);
});

test('the stored value is a hash, not the token, and tokens are unique', () => {
  const a = issueResetToken();
  const b = issueResetToken();
  assert.notEqual(a.token, a.hash);
  assert.equal(a.hash, hashResetToken(a.token));
  assert.equal(a.token.length, 64);
  assert.notEqual(a.token, b.token);
});
