// Test-only resolver. The copied offline companion imports siblings without a
// file extension (a bundler convention). This maps extensionless relative
// specifiers to .ts so Node can load them. It changes nothing on disk.
import { register } from 'node:module';

// Test-only alias: @shared/* -> <repo root>/shared/*. This file sits in
// tests/engines, so the repo root is two levels up.
const sharedRoot = new URL('../../shared/', import.meta.url).href;

const hook = `
const sharedRoot = ${JSON.stringify(sharedRoot)};
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@shared/')) {
    let rest = specifier.slice('@shared/'.length);
    if (!/\\.[a-z]+$/i.test(rest)) rest += '.ts';
    return next(new URL(rest, sharedRoot).href, context);
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    return next(specifier + '.ts', context);
  }
  return next(specifier, context);
}
`;

register('data:text/javascript,' + encodeURIComponent(hook));
