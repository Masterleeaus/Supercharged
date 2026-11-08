import assert from 'node:assert/strict';
import {
  bandForScore,
  normalizeVerifiedAutonomySnapshot,
  computeContractionOnlyAuthority,
} from '../index.mjs';

assert.equal(bandForScore(0), 'suggest');
assert.equal(bandForScore(16), 'assist');
assert.equal(bandForScore(31), 'semi_auto');
assert.equal(bandForScore(51), 'auto');
assert.equal(bandForScore(71), 'trusted_auto');
assert.equal(bandForScore(86), 'predictive');

const snapshot = normalizeVerifiedAutonomySnapshot({
  company_id:'co-1', decision_id:'auth-1', capability:'booking.create',
  effective_score:80, status:'verified', source:'titan-autonomy',
  verified_at:'2026-09-05T00:00:00Z', expires_at:'2026-09-06T00:00:00Z',
  trusted_auto_handshake:{platform:true,user:true,assurance:true},
});
assert.equal(snapshot.authority_owner, 'titan-autonomy');
assert.equal(snapshot.effective_band, 'trusted_auto');

const offlineProtected = computeContractionOnlyAuthority({
  snapshot, connectivity:'offline', protected_action:true,
  now:'2026-09-05T01:00:00Z'
});
assert.equal(offlineProtected.effective_score, 30);
assert.equal(offlineProtected.effective_band, 'assist');
assert.ok(offlineProtected.reason_codes.includes('offline_protected_cap'));

const offlineLocal = computeContractionOnlyAuthority({
  snapshot, connectivity:'offline', protected_action:false,
  now:'2026-09-05T01:00:00Z'
});
assert.equal(offlineLocal.effective_score, 50);

const degraded = computeContractionOnlyAuthority({ snapshot, connectivity:'degraded', now:'2026-09-05T01:00:00Z' });
assert.equal(degraded.effective_score, 70);

const stale = computeContractionOnlyAuthority({
  snapshot:{...snapshot, verified_at:'2026-09-01T00:00:00Z', expires_at:'2026-09-10T00:00:00Z'},
  connectivity:'online', now:'2026-09-05T01:00:00Z', max_snapshot_age_ms:86_400_000
});
assert.equal(stale.effective_score, 30);
assert.ok(stale.reason_codes.includes('stale_authority_snapshot'));

const revoked = computeContractionOnlyAuthority({ snapshot:{...snapshot,status:'revoked'}, now:'2026-09-05T01:00:00Z' });
assert.equal(revoked.effective_score, 0);

assert.throws(() => normalizeVerifiedAutonomySnapshot({...snapshot, source:'local-worker'}), /autonomy-source-invalid/);
assert.throws(() => computeContractionOnlyAuthority({
  snapshot:{...snapshot,effective_score:80},
  previous_effective_score:40,
  previous_snapshot_id:'auth-1',
  local_safety_cap:60,
  now:'2026-09-05T01:00:00Z'
}), /local-authority-increase-forbidden/);

console.log('autonomy contraction PASS');
