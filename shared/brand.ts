/**
 * Canonical product name for server-side fallbacks, default sender names and provider labels.
 * Customer-configured identity (app_name, company name, logo) always wins over these defaults.
 * Compatibility identifiers (storage keys, window globals, DOM id prefixes) are NOT derived from this.
 */
export const PRODUCT_NAME = 'Supercharged' as const;
