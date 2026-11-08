/**
 * Request body size limits for the global JSON and urlencoded parsers (issue #36).
 *
 * Every request gets DEFAULT_BODY_LIMIT. A route that legitimately needs more is listed in
 * BODY_LIMIT_EXCEPTIONS and gets its own limit. Only that method and path get the larger limit.
 *
 * The exceptions are applied by the global parser in server/index.ts, not by a route-level parser.
 * A route-level express.json cannot raise a limit once the global parser has already read the body.
 * Multipart uploads (multer) are not read by these parsers, so they are not affected.
 */
import type { RequestHandler } from "express";

/** Default limit for JSON and urlencoded bodies on every route. */
export const DEFAULT_BODY_LIMIT = "1mb";

export interface BodyLimitException {
  method: "POST" | "PATCH" | "PUT";
  /** Express path. A `:name` segment matches one path segment. */
  path: string;
  limit: string;
  reason: string;
}

export const BODY_LIMIT_EXCEPTIONS: readonly BodyLimitException[] = [
  {
    method: "POST",
    path: "/api/knowledge-base/text",
    limit: "2mb",
    reason: "Text knowledge base items may be up to 300,000 characters (agent-routes.ts). Multi-byte UTF-8 text can reach about 1.2 MB.",
  },
  {
    method: "POST",
    path: "/api/flow-automation/flows",
    limit: "2mb",
    reason: "Flow editor saves the whole flow graph (nodes and edges) as JSON. No size cap exists in code, so this is a provisional limit.",
  },
  {
    method: "PATCH",
    path: "/api/flow-automation/flows/:id",
    limit: "2mb",
    reason: "Same as creating a flow: the editor saves the whole flow graph. Provisional limit.",
  },
  {
    method: "POST",
    path: "/api/webhooks/elevenlabs",
    limit: "2mb",
    reason: "ElevenLabs post-call webhook carries the full call transcript and analysis, which can be large for long calls. Provisional limit.",
  },
];

function pathToPattern(path: string): RegExp {
  const source = path
    .split("/")
    .map((segment) =>
      segment.startsWith(":")
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${source}/?$`, "i");
}

const compiledExceptions = BODY_LIMIT_EXCEPTIONS.map((entry) => ({
  method: entry.method,
  pattern: pathToPattern(entry.path),
  limit: entry.limit,
}));

/** The limit for one request. Query strings are ignored. */
export function bodyLimitFor(method: string | undefined, url: string | undefined): string {
  const path = (url ?? "").split("?")[0] ?? "";
  const verb = (method ?? "").toUpperCase();
  const hit = compiledExceptions.find((entry) => entry.method === verb && entry.pattern.test(path));
  return hit ? hit.limit : DEFAULT_BODY_LIMIT;
}

/**
 * Wraps a body parser so each request uses the limit for its method and path.
 * `build` receives the limit and returns the parser, for example `(limit) => express.json({ limit })`.
 * Parsers are built once per limit value.
 */
export function perRouteBodyParser(build: (limit: string) => RequestHandler): RequestHandler {
  const parsers = new Map<string, RequestHandler>();
  return (req, res, next) => {
    const limit = bodyLimitFor(req.method, req.originalUrl ?? req.url);
    let parser = parsers.get(limit);
    if (!parser) {
      parser = build(limit);
      parsers.set(limit, parser);
    }
    parser(req, res, next);
  };
}
