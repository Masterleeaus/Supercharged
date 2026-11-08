# Pending patch for existing widget files (NOT applied)

Owner decision required. Apply only after the lead approves. Both changes alter behaviour for existing website widgets.

## 1. server/modules/widget/widget-service.ts: fail closed on an empty allowlist

Current code (lines 55-58), which allows every domain when `allowedDomains` is empty:

```ts
  validateDomain(widget: WebsiteWidget, requestDomain: string): boolean {
    if (!widget.allowedDomains || widget.allowedDomains.length === 0) {
      return true;
    }
```

Replacement:

```ts
  validateDomain(widget: WebsiteWidget, requestDomain: string): boolean {
    if (!widget.allowedDomains || widget.allowedDomains.length === 0) {
      return false; // fail closed: an empty allowlist admits no domain
    }
```

Effect: any existing widget with an empty `allowedDomains` stops answering on `/widget/config/:token` and `/widget/session/start` until its domains are set. Run a data check first: `SELECT id FROM website_widgets WHERE allowed_domains IS NULL OR cardinality(allowed_domains) = 0;` (read-only, not run here).

## 2. server/modules/widget/public-widget-routes.ts: stop skipping the check when no Origin or Referer is sent

Current code at line 257 (same pattern at line 531):

```ts
    if (domain && !widgetService.validateDomain(widget, domain)) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }
```

Replacement at line 257:

```ts
    if (!domain || !widgetService.validateDomain(widget, domain)) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }
```

Replacement at line 531:

```ts
    if (!visitorDomain || !widgetService.validateDomain(widget, visitorDomain)) {
```

Effect: requests that send neither Origin nor Referer are refused. Non-browser clients that call these routes directly will break. Confirm with the lead before applying.

## Not proposed here (noted only)

- `public-widget-routes.ts` no longer sends a wildcard. It uses a fail-closed allowlist, `getWidgetAllowedOrigins()` and the CORS middleware near the top of the file, read from the `WIDGET_ALLOWED_ORIGINS` environment variable (comma-separated, for example `https://example.com,https://app.example.org`). When the request `Origin` is on the list, the response sends `Access-Control-Allow-Origin` with that origin and `Vary: Origin`. Any other origin, or an unset or empty variable, gets no CORS header, so the browser blocks cross-origin reads. Same-origin requests are not affected. The new `/embed/*` routes do not use this middleware. A per-widget origin lookup is still a separate change.
- `widget-service.ts` line 259 builds an embed snippet that points at `${baseUrl}/widget/embed.js`. No such route exists in server/modules/widget/. The new `embed-script.js` is the intended replacement.
