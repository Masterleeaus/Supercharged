/**
 * Narrow, area-by-area TypeScript check. Never runs a whole-repo `tsc`.
 *
 * Usage: node scripts/typecheck-area.mjs <area>
 *        node scripts/typecheck-area.mjs --list
 *
 * Each area is a directory (or the loose files directly inside a directory).
 * The check builds one program from that area's files, then reports only
 * diagnostics that belong to files inside the area. Errors in other areas
 * that are pulled in through imports are ignored here; they are owned by
 * the area they live in.
 *
 * Exit 0 when the area has no errors, 1 when it has errors, 2 on bad usage.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Area name -> path inside the repo. A trailing "/" means "loose files only"
// (files directly in that folder, not in its subfolders).
export const AREAS = {
  'shared': 'shared',
  'server-root': 'server/',
  'server/middleware': 'server/middleware',
  'server/utils': 'server/utils',
  'server/lib': 'server/lib',
  'server/infrastructure': 'server/infrastructure',
  'server/storage': 'server/storage',
  'server/types': 'server/types',
  'server/plugins': 'server/plugins',
  'server/integrations': 'server/integrations',
  'server/demo-mode': 'server/demo-mode',
  'server/scripts': 'server/scripts',
  'server/services': 'server/services',
  'server/routes': 'server/routes',
  'server/modules': 'server/modules',
  'server/engines': 'server/engines',
  'server/workforce': 'server/workforce',
  'client/src/hooks': 'client/src/hooks',
  'client/src/contexts': 'client/src/contexts',
  'client/src/lib': 'client/src/lib',
  'client/src/widget': 'client/src/widget',
  'client/src/i18n': 'client/src/i18n',
  'client/src/components': 'client/src/components',
  'client/src/pages': 'client/src/pages',
  'client-src-root': 'client/src/',
};

// Areas that pass today are listed in the "typecheck-required" matrix in
// .github/workflows/pr-checks.yml. Add an area there only after it prints 0 errors here.

function walk(dir, out, recursive) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '_template') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (recursive) walk(full, out, recursive);
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

export function areaFiles(area) {
  const spec = AREAS[area];
  if (!spec) throw new Error(`Unknown area: ${area}`);
  const loose = spec.endsWith('/');
  const target = join(root, loose ? spec.slice(0, -1) : spec);
  if (!existsSync(target)) throw new Error(`Area path missing: ${spec}`);
  if (statSync(target).isFile()) return [target];
  return walk(target, [], !loose);
}

function loadOptions() {
  const configPath = join(root, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  return { ...parsed.options, noEmit: true };
}

export function checkArea(area) {
  const files = areaFiles(area);
  const inArea = (sf) => {
    const rel = relative(root, sf.fileName);
    if (rel.startsWith('..') || rel.includes(`node_modules${sep}`)) return false;
    return files.includes(sf.fileName);
  };
  const program = ts.createProgram({ rootNames: files, options: loadOptions() });
  const diagnostics = [];
  for (const sf of program.getSourceFiles()) {
    if (!inArea(sf)) continue;
    diagnostics.push(...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf));
  }
  return {
    area,
    fileCount: files.length,
    errors: diagnostics.map((d) => ({
      file: d.file ? relative(root, d.file.fileName) : '(global)',
      line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0,
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
    })),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = process.argv[2];
  if (arg === '--list') {
    console.log(Object.keys(AREAS).join('\n'));
    process.exit(0);
  }
  if (!arg || !AREAS[arg]) {
    console.error(`Usage: node scripts/typecheck-area.mjs <area>\nAreas: ${Object.keys(AREAS).join(', ')}`);
    process.exit(2);
  }
  const result = checkArea(arg);
  console.log(`Area ${result.area}: ${result.fileCount} files, ${result.errors.length} error(s).`);
  for (const e of result.errors.slice(0, 50)) {
    console.log(`${e.file}(${e.line}): TS${e.code} ${e.message}`);
  }
  if (result.errors.length > 50) console.log(`... ${result.errors.length - 50} more`);
  process.exit(result.errors.length === 0 ? 0 : 1);
}
