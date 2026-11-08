const LOCALE_RE = /^[A-Za-z]{2,3}(?:_[A-Za-z0-9]{2,8})?$/;

export const TITAN_LOCALE_LOADER_SCHEMA = 'titan.zero.locale-on-demand-loader.v1';

export function normalizeLocale(locale, fallback = 'en') {
  const raw = String(locale || '').trim().replace('-', '_');
  if (!raw || !LOCALE_RE.test(raw)) return fallback;
  const [lang, region] = raw.split('_');
  return region ? `${lang.toLowerCase()}_${region.toUpperCase()}` : lang.toLowerCase();
}

export function createLocaleOnDemandLoader({
  availableLocales = [],
  loadMessages,
  defaultLocale = 'en',
  auditSink = null,
} = {}) {
  if (typeof loadMessages !== 'function') throw new TypeError('loadMessages function is required');
  const available = new Set(availableLocales.map((x) => normalizeLocale(x, defaultLocale)));
  const cache = new Map();
  const inflight = new Map();

  const emit = (event) => {
    if (typeof auditSink === 'function') auditSink({
      schema: TITAN_LOCALE_LOADER_SCHEMA,
      authority_neutral: true,
      identity_confers_authority: false,
      ...event,
    });
  };

  const resolve = (requested) => {
    const normalized = normalizeLocale(requested, defaultLocale);
    if (available.has(normalized)) return normalized;
    const base = normalized.split('_')[0];
    if (available.has(base)) return base;
    const fallback = normalizeLocale(defaultLocale, 'en');
    if (available.size === 0 || available.has(fallback)) return fallback;
    return [...available][0];
  };

  async function load(requestedLocale) {
    const locale = resolve(requestedLocale);
    if (cache.has(locale)) return cache.get(locale);
    if (inflight.has(locale)) return inflight.get(locale);
    const promise = Promise.resolve()
      .then(() => loadMessages(locale))
      .then((messages) => {
        const result = Object.freeze({ locale, messages, source: `titan-zero-locales/${locale}/messages.json` });
        cache.set(locale, result);
        emit({ action: 'load', outcome: 'loaded', locale });
        return result;
      })
      .catch((error) => {
        emit({ action: 'load', outcome: 'failed', locale, error: String(error?.message || error) });
        throw error;
      })
      .finally(() => inflight.delete(locale));
    inflight.set(locale, promise);
    return promise;
  }

  return Object.freeze({
    schema: TITAN_LOCALE_LOADER_SCHEMA,
    resolve,
    load,
    isLoaded: (locale) => cache.has(resolve(locale)),
    clear: (locale) => locale ? cache.delete(resolve(locale)) : cache.clear(),
    loadedLocales: () => Object.freeze([...cache.keys()]),
  });
}
