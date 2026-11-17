/**
 * Removes secret-bearing path segments from a URL path before it is logged (issue #343).
 * Legacy provider webhook routes carry a shared secret as a path segment. The token is replaced by
 * "[redacted]" so access logs, traces and error bodies never hold it. Other segments are unchanged.
 */
const TOKEN_SEGMENT_PATTERNS: RegExp[] = [
  // /api/webhooks/elevenlabs/appointment/:token/:agentId (legacy URL-token route)
  /^(\/api\/webhooks\/elevenlabs\/appointment\/)[^/]+(\/[^/]+)$/,
  // /api/webhooks/elevenlabs/rag-tool/:token/:agentId
  /^(\/api\/webhooks\/elevenlabs\/rag-tool\/)[^/]+(\/[^/]+)$/,
  // /api/webhooks/elevenlabs/form/:token/:formId/:agentId
  /^(\/api\/webhooks\/elevenlabs\/form\/)[^/]+(\/[^/]+\/[^/]+)$/,
  // /api/elevenlabs/tools/play-audio/:token/:agentId
  /^(\/api\/elevenlabs\/tools\/play-audio\/)[^/]+(\/[^/]+)$/,
];

export function redactWebhookTokenPath(urlPath: string): string {
  const pathOnly = urlPath.split('?')[0];
  for (const pattern of TOKEN_SEGMENT_PATTERNS) {
    const match = pattern.exec(pathOnly);
    if (match) {
      return `${match[1]}[redacted]${match[2]}`;
    }
  }
  return pathOnly;
}
