import { afterEach, describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStorage, forCompany, normalizeCompanyContext } from './index.js';
const stores: ReturnType<typeof createSqliteStorage>[] = [];
const tempDirs: string[] = [];
afterEach(async () => { for (const s of stores.splice(0)) await s.close(); for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('SQLite storage', () => {
  it('normalizes legacy tenant input to canonical company_id', () => expect(normalizeCompanyContext({tenant_company_id:'c1'})).toBe('c1'));
  it('rejects missing company context', () => expect(() => normalizeCompanyContext({})).toThrow(/company_id/));
  it('persists and rolls transactions back', async () => {
    const s=createSqliteStorage(':memory:'); stores.push(s); await s.query('CREATE TABLE x(id TEXT PRIMARY KEY, company_id TEXT NOT NULL)');
    await s.query('INSERT INTO x VALUES($1,$2)', ['a','c1']);
    await expect(s.transaction(async tx => { await tx.query('INSERT INTO x VALUES($1,$2)',['b','c1']); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect((await s.query('SELECT * FROM x')).rowCount).toBe(1);
  });
  it('does not enter a transaction when its absolute acquisition deadline has expired', async () => {
    const s=createSqliteStorage(':memory:'); stores.push(s);
    let entered=false;
    await expect(s.transaction(async () => { entered=true; }, { acquireDeadlineMs: performance.now() - 1 }))
      .rejects.toThrow('storage-transaction-acquire-timeout');
    expect(entered).toBe(false);
  });
  it('settles a queued transaction at its acquisition deadline and skips it after the connection frees', async () => {
    const s=createSqliteStorage(':memory:'); stores.push(s);
    let enteredFirst!: () => void; let releaseFirst!: () => void;
    const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve; });
    const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = s.transaction(async () => { enteredFirst(); await firstHeld; });
    await firstEntered;

    let enteredQueued = false;
    const started = performance.now();
    try {
      await expect(s.transaction(async () => { enteredQueued = true; }, { acquireDeadlineMs: started + 120 }))
        .rejects.toThrow('storage-transaction-acquire-timeout');
      expect(performance.now() - started).toBeLessThan(260);
    } finally {
      releaseFirst();
      await first;
      await s.query('SELECT 1');
    }
    expect(enteredQueued).toBe(false);
  });
  it('does not admit a queued callback cancelled by its deadline timer before the absolute deadline', async () => {
    const s=createSqliteStorage(':memory:'); stores.push(s);
    let enteredFirst!: () => void; let releaseFirst!: () => void;
    const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve; });
    const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = s.transaction(async () => { enteredFirst(); await firstHeld; });
    await firstEntered;

    const nativeSetTimeout = globalThis.setTimeout;
    let deadlineTimerShortened = false;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (!deadlineTimerShortened && typeof timeout === 'number' && timeout > 500) {
        deadlineTimerShortened = true;
        return nativeSetTimeout(handler, 0, ...args);
      }
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;

    let enteredQueued = false;
    try {
      const deadline = performance.now() + 1000;
      await expect(s.transaction(async () => { enteredQueued = true; }, { acquireDeadlineMs: deadline }))
        .rejects.toThrow('storage-transaction-acquire-timeout');
      expect(deadlineTimerShortened).toBe(true);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
      releaseFirst();
      await first;
      await s.query('SELECT 1');
    }
    expect(enteredQueued).toBe(false);
  });
  it('preserves callback errors after transaction acquisition passes its deadline', async () => {
    const s=createSqliteStorage(':memory:'); stores.push(s);
    let entered = false;
    const deadline = performance.now() + 20;
    await expect(s.transaction(async () => {
      entered = true;
      await new Promise(resolve => setTimeout(resolve, 35));
      throw new Error('session-fence-timeout');
    }, { acquireDeadlineMs: deadline })).rejects.toThrow('session-fence-timeout');
    expect(entered).toBe(true);
  });
  it('bounds a native SQLite writer lock held by another process', async () => {
    const dir=mkdtempSync(join(tmpdir(),'titan-storage-fence-')); tempDirs.push(dir);
    const filename=join(dir,'lock.db'); const ready=join(dir,'writer-ready'); const s=createSqliteStorage(filename); stores.push(s);
    const child=spawn(process.execPath,['-e',`const Database=require('better-sqlite3');const fs=require('node:fs');const db=new Database(${JSON.stringify(filename)});db.exec('BEGIN IMMEDIATE');fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{db.exec('ROLLBACK');db.close()},700);`],{stdio:['ignore','ignore','inherit']});
    await new Promise<void>((resolve,reject)=>{let watchdog: ReturnType<typeof setTimeout>;const timer=setInterval(()=>{if(existsSync(ready)){clearInterval(timer);clearTimeout(watchdog);resolve();}else if(child.exitCode!==null){clearInterval(timer);clearTimeout(watchdog);reject(new Error(`lock-holder-exit:${child.exitCode}`));}},10);watchdog=setTimeout(()=>{clearInterval(timer);reject(new Error('lock-holder-ready-timeout'));},2000);child.once('error',reject);});
    try {
      let entered=false; const started=performance.now();
      await expect(s.transaction(async()=>{entered=true;},{acquireDeadlineMs:started+180})).rejects.toThrow('storage-transaction-acquire-timeout');
      expect(entered).toBe(false);
      expect(performance.now()-started).toBeLessThan(600);
    } finally {
      child.kill();
      if (child.exitCode === null) await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    }
  });
  it('requires an explicit company for company-scoped access', () => { const s=createSqliteStorage(':memory:'); stores.push(s); expect(() => forCompany(s,'')).toThrow(/company_id/); });
});
