import test from 'node:test';
import assert from 'node:assert/strict';
import {createMembershipGate,createSessionTenantResolver,MEMBERSHIP_SQL,MEMBERSHIP_TABLE} from '../../server/infrastructure/central-sso/tenant-membership.ts';

const companyA='00000000-0000-4000-8000-00000000000a';
const companyB='00000000-0000-4000-8000-00000000000b';
const orgToCompany={'org_alpha':companyA,'org_beta':companyB};

// Fake membership table: user -> set of companies.
function fakeDb(rows){
 const calls=[];
 return {calls,query:async(sql,params)=>{calls.push([sql,params]);
  const [company,user]=params;
  return rows.some(r=>r.company_id===company&&r.user_id===user)?[{'?column?':1}]:[];
 }};
}

function resolver(db,over={}){
 const gate=createMembershipGate({query:db.query});
 return createSessionTenantResolver({
  resolveCompanyForOrg:async(org)=>orgToCompany[org]??null,
  hasActiveMembership:gate,
  ...over,
 });
}

test('user with two memberships sees only the company of the verified org',async()=>{
 const db=fakeDb([{company_id:companyA,user_id:'u1'},{company_id:companyB,user_id:'u1'}]);
 const r=resolver(db);
 assert.deepEqual(await r({orgClaim:'org_alpha',userId:'u1'}),{userId:'u1',companyId:companyA});
 assert.deepEqual(await r({orgClaim:'org_beta',userId:'u1'}),{userId:'u1',companyId:companyB});
});

test('a company passed in input is ignored; the org claim alone picks the tenant',async()=>{
 const db=fakeDb([{company_id:companyA,user_id:'u1'}]);
 const r=resolver(db);
 const out=await r({orgClaim:'org_alpha',userId:'u1',companyId:companyB});
 assert.equal(out.companyId,companyA);
});

test('revoked membership (row removed) refuses access',async()=>{
 const db=fakeDb([{company_id:companyA,user_id:'u1'}]);
 const r=resolver(db);
 assert.notEqual(await r({orgClaim:'org_alpha',userId:'u1'}),null);
 db.calls.length=0;
 const revoked=fakeDb([]);
 assert.equal(await resolver(revoked)({orgClaim:'org_alpha',userId:'u1'}),null);
});

test('user with no membership in the mapped company is refused',async()=>{
 const db=fakeDb([{company_id:companyB,user_id:'u1'}]);
 assert.equal(await resolver(db)({orgClaim:'org_alpha',userId:'u1'}),null);
});

test('unmapped org, bad identifiers and erroring lookups fail closed',async()=>{
 const db=fakeDb([{company_id:companyA,user_id:'u1'}]);
 const r=resolver(db);
 assert.equal(await r({orgClaim:'org_unknown',userId:'u1'}),null);
 assert.equal(await r({orgClaim:'',userId:'u1'}),null);
 assert.equal(await r({orgClaim:'org_alpha',userId:'bad id'}),null);
 assert.equal(await r(null),null);
 const broken=createMembershipGate({query:async()=>{throw new Error('db down')}});
 assert.equal(await broken(companyA,'u1'),false);
 const r2=createSessionTenantResolver({resolveCompanyForOrg:async()=>{throw new Error('x')},hasActiveMembership:async()=>true});
 assert.equal(await r2({orgClaim:'org_alpha',userId:'u1'}),null);
});

test('membership gate reads the table created by migration 0017',async()=>{
 assert.equal(MEMBERSHIP_TABLE,'user_company_memberships');
 assert.match(MEMBERSHIP_SQL,/FROM user_company_memberships\b/);
});

test('membership check is parameterised and tenant-scoped',async()=>{
 const db=fakeDb([{company_id:companyA,user_id:'u1'}]);
 await createMembershipGate({query:db.query})(companyA,'u1');
 assert.equal(db.calls[0][0],MEMBERSHIP_SQL);
 assert.deepEqual(db.calls[0][1],[companyA,'u1']);
 assert.match(MEMBERSHIP_SQL,/company_id = \$1::uuid AND user_id = \$2/);
 assert.equal(await createMembershipGate({query:db.query})('not-a-uuid','u1'),false);
});
