/**
 * Pinned HttpClient for URL fetches (audit item C5). The guard checks the host name, but a DNS answer can change
 * between the check and the connect (DNS rebinding). This client closes that gap by connecting to the address it
 * checked:
 *
 * 1. The name is resolved once through checkPublicHttpTarget. Every returned address must be public, or the
 *    request is refused and no socket is opened.
 * 2. The socket connects to the first checked address. Nothing resolves the name again.
 * 3. The Host header and, for https, the TLS servername are the original host name, so virtual hosts and
 *    certificate checks still use the name the URL gave.
 *
 * The client never follows redirects. The caller (url-source.ts) reads each 3xx and sends the next hop back
 * through this client, which checks it again.
 *
 * Refusals throw UrlRefusedError, not a transport error, so the caller can report them as url_refused.
 * Transport failures throw HttpTransportError with a fixed message that does not echo the URL or the body.
 */
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { HttpClient, HttpRequest, HttpResponse, HttpTransportError } from "../contracts/index.ts";
import { type AddressResolver, checkPublicHttpTarget, UrlRefusedError } from "./ssrf.ts";

/** Same call shape as node:http and node:https request. Tests pass a stub, so no socket is opened. */
export type PinnedRequester = (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;

export interface PinnedHttpOptions {
  resolve: AddressResolver;
  /** Bodies are cut off after this many bytes. The caller's size check then refuses the page as too large. */
  maxBodyBytes: number;
  /** Test seam. Production leaves this unset and uses node:http and node:https. */
  transport?: { http?: PinnedRequester; https?: PinnedRequester };
}

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

/** Builds an HttpClient that connects only to addresses checked on the same request. */
export function createPinnedHttpClient(options: PinnedHttpOptions): HttpClient {
  const requestHttp: PinnedRequester = options.transport?.http ?? httpRequest;
  const requestHttps: PinnedRequester = options.transport?.https ?? httpsRequest;

  return async (request: HttpRequest): Promise<HttpResponse> => {
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer.");
    }
    const target = await checkPublicHttpTarget(request.url, options.resolve);
    const address = target.addresses[0];
    if (address === undefined) {
      throw new UrlRefusedError("resolution", "The host name could not be resolved.");
    }

    const { url } = target;
    const secure = url.protocol === "https:";
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const headers = headersWithoutHost(request.headers);
    headers.host = url.host;
    if (request.body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "content-length")) {
      headers["content-length"] = String(Buffer.byteLength(request.body, "utf8"));
    }

    const requestOptions: RequestOptions = {
      host: address,
      port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers,
      agent: false,
      // SNI and certificate name checks use the original host. An IP literal has no name to send.
      ...(secure && isIP(hostname) === 0 ? { servername: hostname } : {}),
    };
    const send = secure ? requestHttps : requestHttp;
    const maxBytes = options.maxBodyBytes;

    return new Promise<HttpResponse>((resolvePromise, rejectPromise) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const fail = (error: HttpTransportError) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        rejectPromise(error);
      };

      const req = send(requestOptions, (response) => {
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
          const body = Buffer.concat(chunks).subarray(0, maxBytes + 1).toString("utf8");
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
