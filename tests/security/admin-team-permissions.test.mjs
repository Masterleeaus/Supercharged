// Security regression test: admin-team tokens must pass a permission check on sensitive admin routes.
// Static route-guard test: reads the route declarations, because loading the Express app needs the
// full dependency install and a database. Run: node --test tests/security/admin-team-permissions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const USERS = 'server/routes/admin/users-routes.ts';
const TEAM = 'server/routes/admin-team-access.routes.ts';
const read = (rel) => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8').split(/\r?\n/);

function declarations(file, method, path) {
  const hits = read(file).filter((l) => l.includes(`router.${method}('${path}',`));
  assert.equal(hits.length, 1, `expected exactly one ${method.toUpperCase()} ${path} in ${file}`);
  return hits[0];
}

const guarded = [
  ['delete', '/users/:userId', "requireAdminPermission('users', 'delete_users', 'delete')"],
  ['post', '/users/:userId/recover', "requireAdminPermission('users', 'edit_users', 'update')"],
  ['get', '/contacts', "requireAdminPermission('contacts', 'view_contacts', 'read')"],
  ['get', '/users/:userId/webhooks', "requireAdminPermission('users', 'view_users', 'read')"],
  ['delete', '/users/:userId/webhooks/:webhookId', "requireAdminPermission('users', 'edit_users', 'update')"],
  ['post', '/users/:id/block', "requireAdminPermission('users', 'suspend_users', 'update')"],
  ['post', '/users/:id/unblock', "requireAdminPermission('users', 'suspend_users', 'update')"],
];

for (const [method, path, perm] of guarded) {
  test(`${method.toUpperCase()} /api/admin${path} enforces ${perm}`, () => {
    assert.ok(declarations(USERS, method, path).includes(perm), `missing ${perm}`);
  });
}

test('GET /api/admin/analytics (live admin-team handler) enforces settings.analytics_settings.read', () => {
  const line = read(TEAM).find((l) => l.includes("router.get('/analytics',"));
  assert.ok(line, 'analytics route not found');
  assert.ok(line.includes("requireAdminPermission('settings', 'analytics_settings', 'read')"), 'analytics has no permission check');
});

test('every route in users-routes.ts has a permission check, except the shadowed POST /users', () => {
  const verbs = /router\.(get|post|patch|put|delete)\('([^']+)',/;
  const unguarded = read(USERS)
    .filter((l) => verbs.test(l) && !l.includes('requireAdminPermission('))
    .map((l) => l.match(verbs)[0]);
  // POST /users in this file is shadowed by auth-routes.ts (see desk-upgrades.md) and is unreachable.
  assert.deepEqual(unguarded, ["router.post('/users',"]);
});
