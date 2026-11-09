/** Disposable CI-only Inbox schema fixture; never used by the production migration runner. */
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {CANDIDATE,validateInboxRls} from './check-inbox-rls.mjs';
const schema=new URL('../migrations/0010a_inbox.sql',import.meta.url);
export async function prepareInboxPostgres(connectionString){
 if(process.env.INBOX_PG_DISPOSABLE!=='true')throw Error('Inbox PostgreSQL fixture requires INBOX_PG_DISPOSABLE=true');
 if(!connectionString)throw Error('INBOX_PG_INTEGRATION_URL is required');
 const rls=readFileSync(CANDIDATE,'utf8');const issues=validateInboxRls(rls);
 if(issues.length)throw Error('Inbox RLS preflight failed: '+issues.join('; '));
 const client=new pg.Client({connectionString});await client.connect();
 try{
  await client.query(`DO $role$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='desk_app') THEN CREATE ROLE desk_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $role$;`);
  await client.query('BEGIN');
  try{await client.query(readFileSync(schema,'utf8'));await client.query(rls);await client.query('COMMIT');}
  catch(error){await client.query('ROLLBACK');throw error;}
 }finally{await client.end();}
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 await prepareInboxPostgres(process.env.INBOX_PG_INTEGRATION_URL);
 console.log('Disposable Inbox database prepared. Live schema unchanged.');
}
