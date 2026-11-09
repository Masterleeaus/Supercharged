/**
 * Check the migration manifest without connecting to a database.
 * Fails when a required file is missing or the manifest format is unknown.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function listedMigrations(source) {
  const entries = [...source.matchAll(/\{\s*file:\s*'([^']+)',\s*required:\s*(true|false)\s*\}/g)]
    .map(match => ({ file: match[1], required: match[2] === 'true' }));
  if (entries.length === 0) throw new Error('No migration manifest entries found');
  const seen = new Set();
  for (const entry of entries) {
    if (!/^[a-zA-Z0-9_-]+\.sql$/.test(entry.file)) throw new Error('Invalid migration filename: ' + entry.file);
    if (seen.has(entry.file)) throw new Error('Duplicate migration filename: ' + entry.file);
    seen.add(entry.file);
  }
  return entries;
}
export function inventoryReport(source, exists) {
  const entries = listedMigrations(source);
  return {
    entries,
    missingRequired: entries.filter(e => e.required && !exists(e.file)).map(e => e.file),
    missingOptional: entries.filter(e => !e.required && !exists(e.file)).map(e => e.file),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const source = readFileSync(resolve(root, 'scripts/run-safe-migration.mjs'), 'utf8');
  const result = inventoryReport(source, name => existsSync(resolve(root, 'migrations', name)));
  console.log('Listed migrations:', result.entries.length);
  if (result.missingOptional.length) console.warn('Missing optional migrations:', result.missingOptional.join(', '));
  if (result.missingRequired.length) {
    console.error('Missing required migrations:', result.missingRequired.join(', '));
    process.exitCode = 1;
  } else {
    console.log('All required migrations exist.');
  }
}
