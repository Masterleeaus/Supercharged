// Resolver hook used only when `zod` is not installed in this repo's node_modules.
// The test file registers it after a failed plain import of 'zod'. It maps the
// bare specifier 'zod' to the entry file passed in as data.entry, and leaves
// every other specifier alone.
import { pathToFileURL } from 'node:url';

let zodEntryUrl = null;

export function initialize(data) {
  zodEntryUrl = pathToFileURL(data.entry).href;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'zod' && zodEntryUrl) {
    return { url: zodEntryUrl, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}
