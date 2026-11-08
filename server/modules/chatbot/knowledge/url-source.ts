/**
 * URL sources: fetch one page through the injected HttpClient, turn HTML into text, and crawl same-host
 * links. Port of LinkParser (PHP), with the SSRF guard applied to every hop.
 *
 * Differences from the PHP (see DECISIONS.md): redirects are followed here, one hop at a time, with each
 * target checked. Only 307 and 308 are followed, at most 3 hops. Other redirects are refused. Relative links are resolved (the PHP dropped them). A page that fails during a crawl is
 * skipped. A failing start page is an error. Bodies are capped in size.
 */
import type { HttpClient, HttpResponse, HttpTransportError } from "../contracts/index.ts";
import { type AddressResolver, assertPublicHttpUrl, UrlRefusedError } from "./ssrf.ts";
import { normalizeText } from "./chunking.ts";
import { KnowledgeError } from "./errors.ts";

export const DEFAULT_MAX_PAGES = 30;
export const DEFAULT_MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const IMAGE_EXTENSION = /\.(jpe?g|png|gif|bmp|apng|avif|svg|webp|ico|tiff?)$/i;
const SKIPPED_PATH_PARTS = ["/cdn-cgi/"];

export interface FetchOptions {
  http: HttpClient;
  resolve: AddressResolver;
  timeoutMs: number;
  maxBytes?: number;
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
}

const ENTITY_NAMES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITY_NAMES[body.toLowerCase()] ?? match;
  });
}

/** Visible text of an HTML document. Scripts, styles, headers, footers and screen-reader-only text are dropped. */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|header|footer|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(
    /<[^>]+class\s*=\s*["'][^"']*\b(?:screen-reader-text|screen-reader-shortcut)\b[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi,
    " ",
  );
  s = s.replace(/<\/?(?:p|div|br|li|h[1-6]|tr|section|article|td|th)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  return normalizeText(decodeEntities(s));
}

export function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const title = normalizeText(decodeEntities(match[1].replace(/<[^>]+>/g, " ")));
  return title || null;
}

/** Raw href values from anchor tags, in document order. */
export function extractHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const pattern = /<a\s+(?:[^>]*?\s+)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of html.matchAll(pattern)) {
    hrefs.push(decodeEntities(match[1] ?? match[2] ?? ""));
  }
  return hrefs;
}

function transportReason(error: unknown): string {
  const kind = (error as Partial<HttpTransportError> | null)?.kind;
  return kind === "timeout" ? "timed out" : "could not be reached";
}

/**
 * Fetches one public page. Redirects (307 and 308 only) are followed one hop at a time, and each target goes
 * through assertPublicHttpUrl again. The HttpClient must not follow redirects on its own (see DECISIONS.md).
 * Production wiring should pass createPinnedHttpClient (pinned-http.ts) as options.http, so the connect uses
 * the address that was checked.
 */
export async function fetchPublicPage(rawUrl: string, options: FetchOptions): Promise<FetchedPage> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FETCH_BYTES;
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let url: URL;
    try {
      url = await assertPublicHttpUrl(current, options.resolve);
    } catch (error) {
      if (error instanceof UrlRefusedError) {
        throw new KnowledgeError("url_refused", `URL refused: ${error.message}`, 400);
      }
      throw error;
    }

    let response: HttpResponse;
    try {
      response = await options.http({
        method: "GET",
        url: url.toString(),
        headers: { accept: "text/html, text/plain;q=0.9" },
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      // A pinned client refuses an address at connect time. That is a refusal, not a transport failure.
      if (error instanceof UrlRefusedError) {
        throw new KnowledgeError("url_refused", `URL refused: ${error.message}`, 400);
      }
      throw new KnowledgeError("fetch_failed", `The page ${transportReason(error)}.`, 502);
    }

    if (response.status >= 300 && response.status < 400) {
      // Only 307 and 308 keep the method and body, so only those are followed. Any other redirect is refused.
      if (response.status !== 307 && response.status !== 308) {
        throw new KnowledgeError("url_refused", `URL refused: redirect ${response.status} is not followed.`, 400);
      }
      const location = response.headers["location"];
      if (!location) throw new KnowledgeError("fetch_failed", "Redirect without a location.", 502);
      current = new URL(location, url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new KnowledgeError("fetch_failed", `The page returned status ${response.status}.`, 502);
    }

    const contentType = (response.headers["content-type"] ?? "").toLowerCase();
    if (contentType && !contentType.startsWith("text/html") && !contentType.startsWith("text/plain")) {
      throw new KnowledgeError("unsupported_content", "Only HTML and plain text pages can be indexed.", 415);
    }
    if (Buffer.byteLength(response.body, "utf8") > maxBytes) {
      throw new KnowledgeError("too_large", "The page is too large to index.", 413);
    }
    return { url: url.toString(), status: response.status, contentType, body: response.body };
  }
  throw new KnowledgeError("fetch_failed", "Too many redirects.", 502);
}

/**
 * Fetches a start page and, unless single is true, same-host pages linked from it (breadth first).
 * Image links, cdn-cgi paths, fragments and other hosts are skipped.
 */
export async function crawlSite(
  startUrl: string,
  options: FetchOptions & { maxPages?: number; single?: boolean },
): Promise<CrawledPage[]> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const start = await assertPublicHttpUrl(startUrl, options.resolve).catch((error: unknown) => {
    if (error instanceof UrlRefusedError) {
      throw new KnowledgeError("url_refused", `URL refused: ${error.message}`, 400);
    }
    throw error;
  });
  const host = start.hostname.toLowerCase();

  const first = await fetchPublicPage(start.toString(), options);
  const pages: CrawledPage[] = [{ url: first.url, title: extractTitle(first.body) ?? "Untitled", text: htmlToText(first.body) }];
  if (options.single) return pages;

  const seen = new Set<string>([first.url]);
  const queue: string[] = [];
  const enqueueLinks = (html: string, base: string) => {
    for (const href of extractHrefs(html)) {
      let link: URL;
      try {
        link = new URL(href, base);
      } catch {
        continue;
      }
      link.hash = "";
      if (link.protocol !== "http:" && link.protocol !== "https:") continue;
      if (link.hostname.toLowerCase() !== host) continue;
      if (IMAGE_EXTENSION.test(link.pathname)) continue;
      const key = link.toString();
      if (SKIPPED_PATH_PARTS.some((part) => key.includes(part))) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(key);
    }
  };
  enqueueLinks(first.body, first.url);

  while (queue.length > 0 && pages.length < maxPages) {
    const next = queue.shift() as string;
    let page: FetchedPage;
    try {
      page = await fetchPublicPage(next, options);
    } catch {
      continue; // A broken linked page is skipped, as in the PHP.
    }
    pages.push({ url: page.url, title: extractTitle(page.body) ?? "Untitled", text: htmlToText(page.body) });
    enqueueLinks(page.body, page.url);
  }
  return pages;
}
