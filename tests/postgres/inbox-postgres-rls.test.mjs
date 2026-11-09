import test from 'node:test';import assert from 'node:assert/strict';
import {A,B,enabled,fixture,id,thread} from './inbox-postgres-support.mjs';
test('PostgreSQL: restricted role sees no rows without tenant context',{skip:!enabled},async()=>{
 const f=fixture();try{const t=thread(A,id('none'));await f.store.insertThread(t);const c=await f.pool.connect();try{
  await c.query('BEGIN');await c.query('SET LOCAL ROLE "desk_app"');
  const rows=(await c.query('SELECT id FROM inbox_threads')).rows;assert.deepEqual(rows,[]);await c.query('ROLLBACK');
 }finally{c.release();}}finally{await f.close();}
});
test('PostgreSQL: direct wrong-tenant insert rejected by WITH CHECK',{skip:!enabled},async()=>{
 const f=fixture();try{const c=await f.pool.connect();try{
  await c.query('BEGIN');await c.query('SET LOCAL ROLE "desk_app"');await c.query('SELECT set_config($1,$2,true)',['app.company_id',A]);
  await assert.rejects(c.query('INSERT INTO inbox_threads(id,company_id,channel) VALUES($1,$2,$3)',[id('forged'),B,'email']),/row-level security/i);
  await c.query('ROLLBACK');
 }finally{c.release();}}finally{await f.close();}
});

test('PostgreSQL: restricted role cannot read other-tenant rows through direct SQL',{skip:!enabled},async()=>{
 const f=fixture();try{
  const t=thread(B,id('invisible'));await f.store.insertThread(t);
  const client=await f.pool.connect();try{
   await client.query('BEGIN');await client.query('SET LOCAL ROLE "desk_app"');
   await client.query('SELECT set_config($1,$2,true)',['app.company_id',A]);
   const rows=(await client.query('SELECT id FROM inbox_threads WHERE id=$1',[t.id])).rows;
   assert.deepEqual(rows,[]);await client.query('ROLLBACK');
  }finally{client.release();}
 }finally{await f.close();}
});
