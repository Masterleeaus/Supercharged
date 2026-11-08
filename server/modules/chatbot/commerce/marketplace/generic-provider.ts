/**
 * Generic marketplace provider over the injected HttpClient. Port of GenericMarketplaceReadProvider.php,
 * GenericMarketplaceWriteProvider.php, AbstractMarketplace{Read,Write}Provider.php and the gateway transports
 * (GatewayMarketplaceTransport.php, GatewayMarketplaceWriteTransport.php). No vendor SDK, no global fetch.
 *
 * The provider talks to one gateway that the operator configures. The gateway holds the marketplace credentials
 * and calls the marketplace. Rules, each recorded in DECISIONS.md:
 *  - The gateway base URL comes from the operator, never from a tenant, and must be https.
 *  - Every request has a timeoutMs and an HMAC-SHA256 signature of its body. The signing secret is read from the
 *    connection's encrypted credential bag and must be at least 32 characters. Missing means refused, not unsigned.
 *  - A write receives only the reviewed changes, the expected source hash and the idempotency key. No confirmation
 *    token is part of any request, so the token cannot reach this provider.
 *  - A definite rejection (4xx) is returned as a result. A 5xx or a transport failure throws, because the outcome
 *    at the marketplace is unknown. The idempotency key makes a retry safe.
 *  - Provider text is never copied into an error or a result.
 */
import { createHmac } from "node:crypto";
import type {
  CommerceCredentials,
  HttpClient,
  HttpResponse,
  MarketplaceCapability,
  MarketplaceConnectionRef,
  MarketplaceInventoryLevel,
  MarketplaceListing,
  MarketplaceOrderImportPage,
  MarketplaceProvider,
  MarketplaceReadOps,
  MarketplaceWriteOps,
  MarketplaceWriteResult,
  RateLimitHooks,
} from "../../contracts/index.ts";
import { MarketplaceError } from "./errors.ts";
import { canonicalJson, sha256Hex, type MarketplaceWriteOperation, type ProviderRollbackRequest, type ProviderWriteRequest } from "./operations.ts";

export const GATEWAY_SIGNING_SECRET_KEY = "gateway_signing_secret";
export const MIN_GATEWAY_SECRET_LENGTH = 32;
export const GENERIC_READ_TIMEOUT_MS = 20_000;
export const GENERIC_WRITE_TIMEOUT_MS = 30_000;
export const GENERIC_CAPABILITIES: readonly MarketplaceCapability[] = [
  "read_listings",
  "read_inventory",
  "import_orders",
  "write_listing",
  "write_inventory",
  "write_price",
];

/** Operation names the gateway understands. Same names as the PHP generic provider. */
export const GATEWAY_READ_OPERATIONS = {
  search: "listings.search",
  get: "listings.get",
  inventory: "inventory.get",
  orders: "orders.list",
} as const;

export const GATEWAY_WRITE_OPERATIONS: Readonly<Record<MarketplaceWriteOperation, string>> = {
  update_listing: "listing.update",
  update_price: "listing.price.update",
  update_inventory: "listing.inventory.update",
  pause_listing: "listing.pause",
  resume_listing: "listing.resume",
};

export interface GenericGatewayOptions {
  /** Operator-set gateway base URL. Must be https. Never taken from a tenant. */
  baseUrl: string;
  /** Limiter that the provider exposes through MarketplaceProvider.rateLimit. */
  rateLimit: RateLimitHooks;
  /** Loads and decrypts the connection's credential bag. Null when the connection is missing or belongs to another company. */
  loadCredentials: (companyId: string, connectionId: string) => Promise<CommerceCredentials | null>;
  /** False builds a read-only provider. Default true. */
  writable?: boolean;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
}

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Signs a request body. Returned as lower-case hex, the same format the PHP gateway uses. */
export function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * Normalises one listing from the gateway. Returns null when the payload is not a usable listing (no id, a
 * price that is not a non-negative integer, or a currency that is not three upper-case letters). The source hash
 * is computed here over the normalised fields, so it does not depend on what the gateway sends as a hash.
 */
export function normaliseListing(provider: string, payload: unknown): MarketplaceListing | null {
  if (!isRecord(payload)) return null;
  const externalListingId = text(payload.external_listing_id ?? payload.id);
  if (externalListingId === "") return null;
  const price = isRecord(payload.price) ? payload.price : {};
  const priceMinor = price.amount ?? payload.price_amount ?? payload.price_minor;
  if (!isNonNegativeInteger(priceMinor)) return null;
  const currency = text(price.currency ?? payload.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  const quantity = isNonNegativeInteger(payload.quantity) ? payload.quantity : null;
  const attributes = isRecord(payload.attributes) ? payload.attributes : {};
  const shape = {
    provider: provider.toLowerCase(),
    externalListingId,
    title: text(payload.title),
    description: text(payload.description),
    priceMinor,
    currency,
    quantity,
    status: text(payload.status),
    attributes,
    url: typeof payload.url === "string" ? payload.url : typeof payload.product_url === "string" ? payload.product_url : null,
  };
  return {
    externalListingId,
    title: shape.title,
    priceMinor,
    currency,
    quantity,
    sourceHash: sha256Hex(canonicalJson(shape)),
    raw: { provider: shape.provider, status: shape.status, description: shape.description, attributes, url: shape.url },
  };
}

/**
 * Normalises one order to the shape order-ops import reads (snake_case, as the PHP normaliser emits). Amounts are
 * passed through unchanged so that the import can refuse a non-integer. Nothing is rounded or truncated here.
 */
export function normaliseOrder(provider: string, payload: unknown): Json | null {
  if (!isRecord(payload)) return null;
  const shape: Json = {
    provider: provider.toLowerCase(),
    external_order_id: text(payload.external_order_id ?? payload.id),
    status: text(payload.status) || "unknown",
    currency: text(payload.currency).toUpperCase(),
    total_amount: payload.total_amount ?? payload.total,
    buyer: isRecord(payload.buyer) ? { display_name: text(payload.buyer.display_name) } : { display_name: "" },
    placed_at: typeof payload.placed_at === "string" ? payload.placed_at : null,
    updated_at: typeof payload.updated_at === "string" ? payload.updated_at : null,
    fulfillment_status: typeof payload.fulfillment_status === "string" ? payload.fulfillment_status : null,
    lines: Array.isArray(payload.lines) ? payload.lines.filter(isRecord) : [],
  };
  return { ...shape, source_hash: sha256Hex(canonicalJson(shape)) };
}

function gatewayBase(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new MarketplaceError("misconfigured", "The marketplace gateway URL is not valid.");
  }
  if (parsed.protocol !== "https:") throw new MarketplaceError("misconfigured", "The marketplace gateway must use https.");
  return baseUrl.replace(/\/+$/, "");
}

function parseBody(response: HttpResponse): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    return undefined;
  }
}

/** Reads a successful JSON object or throws. The body is never put in the error. */
function successObject(response: HttpResponse): Json {
  if (response.status < 200 || response.status > 299) {
    throw new MarketplaceError("provider_unavailable", "Marketplace is temporarily unavailable.");
  }
  const parsed = parseBody(response);
  if (!isRecord(parsed)) throw new MarketplaceError("provider_unavailable", "Marketplace returned an invalid response.");
  return parsed;
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : "provider_rejected";
}

export function createGenericMarketplaceProvider(options: GenericGatewayOptions): MarketplaceProvider {
  const base = gatewayBase(options.baseUrl);
  const readTimeoutMs = options.readTimeoutMs ?? GENERIC_READ_TIMEOUT_MS;
  const writeTimeoutMs = options.writeTimeoutMs ?? GENERIC_WRITE_TIMEOUT_MS;
  const key = "generic" as const;

  function assertRef(ref: MarketplaceConnectionRef): void {
    if (ref.provider !== key) throw new MarketplaceError("provider_mismatch", "Provider registered under the wrong key.");
  }

  async function signingSecret(ref: MarketplaceConnectionRef): Promise<string> {
    const bag = await options.loadCredentials(ref.companyId, ref.connectionId);
    const secret = bag?.[GATEWAY_SIGNING_SECRET_KEY];
    if (typeof secret !== "string" || secret.length < MIN_GATEWAY_SECRET_LENGTH) {
      throw new MarketplaceError("misconfigured", "The marketplace gateway signing secret is missing or too short.");
    }
    return secret;
  }

  /** Sends one signed POST. The envelope carries the connection reference, never a credential or a token. */
  async function send(
    http: HttpClient,
    ref: MarketplaceConnectionRef,
    path: "/v1/marketplace/read" | "/v1/marketplace/write",
    operation: string,
    envelope: Json,
    timeoutMs: number,
    extraHeaders: Record<string, string>,
  ): Promise<HttpResponse> {
    const secret = await signingSecret(ref);
    const body = JSON.stringify({ operation, provider: key, connection_reference: ref.connectionId, ...envelope });
    return http({
      method: "POST",
      url: `${base}${path}`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-marketplace-provider": key,
        "x-marketplace-operation": operation,
        "x-payload-signature": signBody(body, secret),
        ...extraHeaders,
      },
      body,
      timeoutMs,
    });
  }

  const read: MarketplaceReadOps = {
    async searchListings(ref, query, http) {
      assertRef(ref);
      const response = await send(http, ref, "/v1/marketplace/read", GATEWAY_READ_OPERATIONS.search, {
        payload: { keywords: query.keywords ?? "", cursor: query.cursor, limit: query.limit },
      }, readTimeoutMs, {});
      const json = successObject(response);
      const rows = listOf(json.items ?? json.listings)
        .map((item) => normaliseListing(key, item))
        .filter((item): item is MarketplaceListing => item !== null);
      const nextCursor = typeof json.next_cursor === "string" && json.next_cursor !== "" ? json.next_cursor : null;
      return { rows, nextCursor };
    },

    async getListing(ref, externalListingId, http) {
      assertRef(ref);
      const response = await send(http, ref, "/v1/marketplace/read", GATEWAY_READ_OPERATIONS.get, {
        payload: { external_listing_id: externalListingId },
      }, readTimeoutMs, {});
      const json = successObject(response);
      return normaliseListing(key, json.item ?? json.listing);
    },

    async getInventory(ref, externalListingIds, http) {
      assertRef(ref);
      const response = await send(http, ref, "/v1/marketplace/read", GATEWAY_READ_OPERATIONS.inventory, {
        payload: { external_listing_ids: [...externalListingIds] },
      }, readTimeoutMs, {});
      const json = successObject(response);
      const levels: MarketplaceInventoryLevel[] = [];
      for (const entry of listOf(json.levels ?? json.items ?? json.inventory)) {
        if (!isRecord(entry)) continue;
        const id = text(entry.external_listing_id);
        if (id === "" || !isNonNegativeInteger(entry.quantity)) continue;
        levels.push({ externalListingId: id, quantity: entry.quantity });
      }
      return levels;
    },

    async importOrders(ref, cursor, http) {
      assertRef(ref);
      const response = await send(http, ref, "/v1/marketplace/read", GATEWAY_READ_OPERATIONS.orders, {
        payload: { cursor: cursor ?? {} },
      }, readTimeoutMs, {});
      const json = successObject(response);
      const orders = listOf(json.orders)
        .map((order) => normaliseOrder(key, order))
        .filter((order): order is Json => order !== null);
      const nextCursor = isRecord(json.next_cursor) ? json.next_cursor : null;
      return { orders, nextCursor } as MarketplaceOrderImportPage;
    },
  };

  /** Shared path for execute and rollback. Refusals that never reach the marketplace return rejected. */
  async function mutate(
    ref: MarketplaceConnectionRef,
    request: ProviderWriteRequest,
    http: HttpClient,
    mode: "execute" | "rollback",
    changes: Record<string, unknown>,
  ): Promise<MarketplaceWriteResult> {
    assertRef(ref);
    const providerOperation = GATEWAY_WRITE_OPERATIONS[request.providerOperation];
    if (providerOperation === undefined) {
      return { status: "rejected", errorCode: "unsupported_operation", message: "This marketplace does not support the requested change." };
    }
    if (request.expectedSourceHash === "" || request.idempotencyKey === "") {
      return { status: "rejected", errorCode: "invalid_request", message: "The change is missing its source hash or idempotency key." };
    }
    const response = await send(http, ref, "/v1/marketplace/write", providerOperation, {
      external_listing_id: request.externalListingId,
      expected_source_hash: request.expectedSourceHash,
      idempotency_key: request.idempotencyKey,
      payload: { changes, mode },
    }, writeTimeoutMs, {
      "x-idempotency-key": request.idempotencyKey,
      "x-expected-source-hash": request.expectedSourceHash,
    });

    if (response.status === 409) {
      const json = parseBody(response);
      const current = isRecord(json) ? text(json.current_source_hash) : "";
      if (current === "") throw new MarketplaceError("provider_unavailable", "Marketplace returned an invalid conflict response.");
      return { status: "conflict", currentSourceHash: current };
    }
    if (response.status === 429) {
      return { status: "rejected", errorCode: "rate_limited", message: "The marketplace is rate limiting writes." };
    }
    if (response.status >= 400 && response.status < 500) {
      const json = parseBody(response);
      const code = safeErrorCode(isRecord(json) ? json.error_code : undefined);
      return { status: "rejected", errorCode: code, message: "The marketplace rejected the change." };
    }

    const json = successObject(response);
    const listing = normaliseListing(key, json.listing ?? json.item);
    if (listing === null) throw new MarketplaceError("provider_unavailable", "Marketplace write did not return the listing state.");
    if (mode === "rollback") return { status: "applied", sourceHash: listing.sourceHash, rollbackState: {} };
    if (!isRecord(json.rollback_state)) throw new MarketplaceError("provider_unavailable", "Marketplace write did not return the rollback state.");
    return { status: "applied", sourceHash: listing.sourceHash, rollbackState: json.rollback_state };
  }

  const write: MarketplaceWriteOps = {
    execute: (ref, request, http) => mutate(ref, request as ProviderWriteRequest, http, "execute", request.changes),
    rollback: (ref, request, http) => mutate(ref, request as ProviderRollbackRequest, http, "rollback", (request as ProviderRollbackRequest).rollbackState),
  };

  return {
    key,
    capabilities: () => [...GENERIC_CAPABILITIES],
    read,
    write: options.writable === false ? null : write,
    rateLimit: options.rateLimit,
  };
}
