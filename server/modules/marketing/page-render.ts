/**
 * Safe HTML rendering for a marketing landing page.
 *
 * Every user-authored string is HTML-escaped before it is inserted. The CTA link
 * must be an absolute https URL. The output has no script
 * element, no inline event handlers and no external resources.
 *
 * Pure function: no I/O, no Express, no storage.
 */

export interface RenderLandingPageInput {
  title: string;
  headline: string;
  body: string;
  ctaText: string;
  ctaUrl: string;
  companyId: string;
}

export type RenderLandingPageFailure =
  | 'invalid_input'
  | 'too_long'
  | 'unsafe_url'
  | 'invalid_company';

export type RenderLandingPageResult =
  | { ok: true; html: string }
  | { ok: false; reason: RenderLandingPageFailure };

export const LANDING_PAGE_LIMITS = {
  title: 120,
  headline: 200,
  body: 5000,
  ctaText: 40,
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Any C0/C1 control character, DEL, or whitespace other than a plain space.
// A URL containing these is refused rather than normalised, because browsers
// strip tabs and newlines from URLs ("java\tscript:" is still javascript:).
const UNSAFE_URL_CHARS = /[\u0000- \u007f-\u009f\s\\]/;

/** Escape the five HTML-significant characters for text and quoted attribute contexts. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** True only for absolute https URLs with a host. Relative and protocol-relative URLs are refused. */
export function isSafeCtaUrl(url: string): boolean {
  if (url.length === 0 || UNSAFE_URL_CHARS.test(url)) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.hostname.length > 0;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function renderLandingPage(input: RenderLandingPageInput): RenderLandingPageResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, reason: 'invalid_input' };
  }

  const { title, headline, body, ctaText, ctaUrl, companyId } = input;

  if (!isString(companyId) || !UUID_PATTERN.test(companyId)) {
    return { ok: false, reason: 'invalid_company' };
  }

  if (
    !isString(title) ||
    !isString(headline) ||
    !isString(body) ||
    !isString(ctaText) ||
    !isString(ctaUrl)
  ) {
    return { ok: false, reason: 'invalid_input' };
  }

  if (
    codePointLength(title) > LANDING_PAGE_LIMITS.title ||
    codePointLength(headline) > LANDING_PAGE_LIMITS.headline ||
    codePointLength(body) > LANDING_PAGE_LIMITS.body ||
    codePointLength(ctaText) > LANDING_PAGE_LIMITS.ctaText
  ) {
    return { ok: false, reason: 'too_long' };
  }

  if (!isSafeCtaUrl(ctaUrl)) {
    return { ok: false, reason: 'unsafe_url' };
  }

  const bodyHtml = escapeHtml(body)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph}</p>`)
    .join('\n    ');

  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtml(title)}</title>`,
    '  <style>',
    '    body { margin: 0; font-family: system-ui, sans-serif; line-height: 1.5; color: #1a1a1a; background: #ffffff; }',
    '    main { max-width: 720px; margin: 0 auto; padding: 48px 24px; }',
    '    h1 { font-size: 2rem; margin: 0 0 24px; }',
    '    p { white-space: pre-line; margin: 0 0 16px; }',
    '    .cta { display: inline-block; margin-top: 24px; padding: 12px 20px; border-radius: 6px; background: #1a1a1a; color: #ffffff; text-decoration: none; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <main>',
    `    <h1>${escapeHtml(headline)}</h1>`,
    `    ${bodyHtml}`,
    `    <a class="cta" href="${escapeHtml(ctaUrl)}">${escapeHtml(ctaText)}</a>`,
    '  </main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');

  return { ok: true, html };
}
