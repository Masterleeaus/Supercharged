// Checklist section 3: company-specific configuration must not leak into shared
// role files. Every role file is read as text, comments are stripped, and the
// remaining code is checked for customer contact details, credential-looking
// strings and hard-coded company names.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));

// Company names that must never appear hard-coded in a role file.
// Left empty: a survey of the role files found no hard-coded company name
// (they use the {{company_name}} placeholder instead).
const COMPANY_NAMES = [];

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
const PLACEHOLDER_EMAIL_DOMAIN = /@(?:[A-Za-z0-9-]+\.)*example\.com\b/i;
// 9 or more digits, optionally led by +, with single spaces or hyphens between digits.
const PHONE = /(?<![\w.])\+?\d(?:[ -]?\d){8,}(?![\w.])/g;
const CREDENTIALS = [
  { name: 'sk_ key', re: /\bsk_/ },
  { name: 'pk_ key', re: /\bpk_/ },
  { name: 'eyJ token', re: /\beyJ/ },
  { name: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/ },
  { name: 'password=', re: /password\s*=/i },
  { name: 'api_key=', re: /api_key\s*=/i },
];

// Remove // line comments and /* */ block comments, leaving string literals
// intact and keeping every newline so reported line numbers stay correct.
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          out += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      if (i < n) {
        out += src[i];
        i++;
      }
    } else if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function findMatches(stripped, re) {
  const hits = [];
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = global.exec(stripped)) !== null) {
    hits.push({ line: lineOf(stripped, m.index), value: m[0] });
    if (m[0].length === 0) global.lastIndex++;
  }
  return hits;
}

// Returns the list of violations for one file as { line, rule } records.
// The matched value is deliberately not returned or printed.
export function checkRoleSource(src) {
  const stripped = stripComments(src);
  const violations = [];

  for (const hit of findMatches(stripped, EMAIL)) {
    const domain = hit.value.slice(hit.value.indexOf('@'));
    if (!PLACEHOLDER_EMAIL_DOMAIN.test(domain)) {
      violations.push({ line: hit.line, rule: 'email address' });
    }
  }

  for (const hit of findMatches(stripped, PHONE)) {
    violations.push({ line: hit.line, rule: 'phone number' });
  }

  for (const { name, re } of CREDENTIALS) {
    for (const hit of findMatches(stripped, re)) {
      violations.push({ line: hit.line, rule: `credential (${name})` });
    }
  }

  for (const company of COMPANY_NAMES) {
    const re = new RegExp(company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    for (const hit of findMatches(stripped, re)) {
      violations.push({ line: hit.line, rule: 'hard-coded company name' });
    }
  }

  return violations;
}

const roleFiles = readdirSync(rolesDir)
  .filter((f) => !f.startsWith('_') && /\.(ts|mjs|js)$/.test(f))
  .sort();

test('role directory contains role files to check', () => {
  assert.ok(roleFiles.length > 0, 'no role files found');
});

for (const file of roleFiles) {
  const label = path.basename(file);
  const src = readFileSync(path.join(rolesDir, file), 'utf8');
  const violations = checkRoleSource(src);
  const rules = [
    ['no email address literal', (v) => v.rule === 'email address'],
    ['no phone number literal', (v) => v.rule === 'phone number'],
    ['no credential-looking string', (v) => v.rule.startsWith('credential')],
    ['no hard-coded company name', (v) => v.rule === 'hard-coded company name'],
  ];
  for (const [ruleName, pick] of rules) {
    test(`${label}: ${ruleName}`, () => {
      const bad = violations.filter(pick);
      const where = bad.map((v) => `${label}:${v.line} (${v.rule})`).join('; ');
      assert.equal(bad.length, 0, `violations: ${where}`);
    });
  }
}
