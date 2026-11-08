/**
 * Pinned HttpClient for outbound webhook sends (audit item C5). Same approach as knowledge/pinned-http.ts, copied
 * for the minimum this slice needs so events/ does not import from knowledge/:
 *
 * 1. The URL is checked with checkPublicWebhookTarget. The name is resolved once, and every returned address must
 *    be public. A refusal throws WebhookUrlRefusedError and no socket is opened.
 * 2. The socket connects to the first checked address. Nothing resolves the name again, so a DNS rebind between
 *    the check and the connect cannot change the target.
 * 3. The Host header and the TLS servername are the original host name, so certificate checks use that name.
 *
 * The client never follows redirects. It returns each 3xx response as is, and the dispatcher sends the next hop
 * back through this client, which checks it again. Webhooks are https only on port 443 (see ssrf.ts), so this
 * client has no plain-http path.
 */
import { request as httpsRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { HttpClient, HttpRequest, HttpResponse, HttpTransportError } from "../contracts/index.ts";
import { checkPublicWebhookTarget, WebhookUrlRefusedError, type WebhookAddressResolver } from "./ssrf.ts";

/** Same call shape as node:https request. Tests pass a stub, so no socket is opened. */
export type PinnedWebhookRequester = (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;

export interface PinnedWebhookOptions {
  resolve: WebhookAddressResolver;
  /** Test seam. Production leaves this unset and uses node:https. */
  transport?: { https?: PinnedWebhookRequester };
}

/** The dispatcher reads only the status and the Location header. The body is cut off at this size. */
export const WEBHOOK_MAX_RESPONSE_BYTES = 4096;

function transportError(kind: HttpTransportError["kind"], message: string): HttpTransportError {
  return Object.assign(new Error(message), { kind, message });
}

function headersWithoutHost(input: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    if (name.toLowerCase() !== "host") out[name] = value;
  }
  return out;
}

/** Builds an HttpClient for webhook sends that connects only to addresses checked on the same request. */
export function createPinnedWebhookHttp(options: PinnedWebhookOptions): HttpClient {
  const requestHttps: PinnedWebhookRequester = options.transport?.https ?? httpsRequest;

  return async (request: HttpRequest): Promise<HttpResponse> => {
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer.");
    }
    const target = await checkPublicWebhookTarget(request.url, options.resolve);
    const address = target.addresses[0];
    if (address === undefined) {
      throw new WebhookUrlRefusedError("resolution", "The host name could not be resolved.");
    }

    const { url } = target;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const headers = headersWithoutHost(request.headers);
    headers.host = url.host;
    if (request.body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "content-length")) {
      headers["content-length"] = String(Buffer.byteLength(request.body, "utf8"));
    }

    const requestOptions: RequestOptions = {
      host: address,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers,
      agent: false,
      // SNI and certificate name checks use the original host. An IP literal has no name to send.
      ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
    };
    const maxBytes = WEBHOOK_MAX_RESPONSE_BYTES;

    return new Promise<HttpResponse>((resolvePromise, rejectPromise) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const fail = (error: HttpTransportError) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        rejectPromise(error);
      };

      const req = requestHttps(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;

        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          const responseHeaders: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
          }
          const body = Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
          resolvePromise({ status: response.statusCode ?? 0, headers: responseHeaders, body });
        };

        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size > maxBytes) {
            finish();
            response.destroy();
          }
        });
        response.on("end", finish);
        response.on("error", () => fail(transportError("network", "Response failed.")));
      });

      req.on("error", () => fail(transportError("network", "Request failed.")));
      timer = setTimeout(() => {
        fail(transportError("timeout", "Request timed out."));
        req.destroy();
      }, request.timeoutMs);

      if (request.body !== undefined) {
        req.end(request.body);
      } else {
        req.end();
      }
    });
  };
}
