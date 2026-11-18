// Licence: original TitanZero test code. Issue #195: every SQL site on the Central-link path is either
// tenant-scoped by the verified company key, or is a documented global table. A new SQL site fails this test
// until it is reviewed and added to the list below.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => fs.readFileSync(`${root}${rel}`, 'utf8');
const DIRS = ['server/infrastructure/central-link', 'server/infrastructure/central-sso'];
const SQL_SITE = /\.query\(|\bsql`/;

// Reviewed global sites. Each entry explains why no company key applies.
const GLOBAL_SITES = {
  'server/infrastructure/central-link/link-assertion.ts': 'link_nonces: single-use replay protection keyed by nonce. No tenant data.',
  'server/infrastructure/central-sso/pending-store-db.ts': 'pending SSO state keyed by state hash, before any company is known. Count cap is global.',
};

function sqlFiles() {
  const out = [];
  for (const dir of DIRS) {
    for (const name of fs.readdirSync(`${root}${dir}`)) {
      if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(`${dir}/${name}`);
    }
  }
  return out;
}

test('every SQL site on the Central-link path is either reviewed-global or company-scoped', () => {
  for (const rel of sqlFiles()) {
    const src = read(rel);
    if (!SQL_SITE.test(src)) continue;
    const scoped = /withTenant\(|company_id\s*=\s*\$\d|companyId\s*=|app_central_desk_resolve_link\(/.test(src);
    const reviewedGlobal = Object.hasOwn(GLOBAL_SITES, rel);
    assert.ok(scoped || reviewedGlobal, `${rel} has SQL with no company key and no reviewed global entry`);
  }
});

test('the reviewed global list has no stale entries', () => {
  for (const rel of Object.keys(GLOBAL_SITES)) {
    assert.ok(fs.existsSync(`${root}${rel}`), `${rel} is listed as global but does not exist`);
    assert.ok(SQL_SITE.test(read(rel)), `${rel} is listed as global but has no SQL site`);
  }
});

test('the company-scoped sites carry the verified company key into the query', () => {
  const link = read('server/infrastructure/central-sso/link-query.ts');
  assert.match(link, /withTenant\(pool,companyId/, 'link query must run inside withTenant with the verified company');
  assert.match(link, /app_central_desk_resolve_link\(\$1,\$2,\$3::uuid\)/);

  const membership = read('server/infrastructure/central-sso/tenant-membership.ts');
  assert.match(membership, /WHERE company_id = \$1::uuid AND user_id = \$2/);
});

test('the account resolver refuses a link row from another company', () => {
  const resolver = read('server/infrastructure/central-sso/account-resolver.ts');
  assert.match(resolver, /row\.company_id!==input\.companyId/);
});
