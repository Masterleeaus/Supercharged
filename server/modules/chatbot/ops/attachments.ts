/**
 * Attachment storage for the chatbot. Port of AttachmentRuntime.php, with three differences recorded in DECISIONS.md:
 * the declared type is checked against the bytes, the storage key is random and never carries the filename, and
 * downloads need a signed, company-bound, expiring token.
 *
 * Bytes go through an injected AttachmentBlobStore. This module never touches the local disk.
 * Metadata goes through an injected AttachmentMetaStore (Drizzle in production, in-memory in tests).
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { AttachmentRecord, AttachmentStore } from "../contracts/index.ts";
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";

/** 20 MiB, the PHP default for chatbot.attachments.max_size_kb. */
export const ATTACHMENT_MAX_BYTES = 20480 * 1024;
/** Upper bound for a download link. The PHP had no signed links; 15 minutes is the cap used here. */
export const DOWNLOAD_TTL_MAX_SECONDS = 900;
export const SIGNING_KEY_MIN_LENGTH = 32;
export const ATTACHMENT_KEY_PREFIX = "chatbot/attachments";

interface AllowedType {
  extension: string;
  kind: "binary" | "text";
}

/** Same allow-list as chatbot.attachments.allowed_mime_types in the PHP config. */
export const ALLOWED_ATTACHMENT_TYPES: Readonly<Record<string, AllowedType>> = {
  "image/jpeg": { extension: "jpg", kind: "binary" },
  "image/png": { extension: "png", kind: "binary" },
  "image/gif": { extension: "gif", kind: "binary" },
  "image/webp": { extension: "webp", kind: "binary" },
  "application/pdf": { extension: "pdf", kind: "binary" },
  "text/plain": { extension: "txt", kind: "text" },
  "text/csv": { extension: "csv", kind: "text" },
  "application/zip": { extension: "zip", kind: "binary" },
  "audio/mpeg": { extension: "mp3", kind: "binary" },
  "audio/ogg": { extension: "ogg", kind: "binary" },
  "video/mp4": { extension: "mp4", kind: "binary" },
};

/** Same list as chatbot.attachments.blocked_extensions in the PHP config. */
export const BLOCKED_ATTACHMENT_EXTENSIONS: readonly string[] = [
  "php", "phtml", "phar", "exe", "com", "bat", "cmd", "sh", "js", "html", "htm", "svg",
];

export function normaliseContentType(raw: string): string {
  return raw.split(";")[0]!.trim().toLowerCase();
}

/** Control characters and path separators become "-". The result is capped at 255 characters. */
export function sanitiseFilename(raw: string): string {
  const cleaned = raw.replace(/[\x00-\x1F\x7F\\/]+/g, "-").trim();
  const capped = Array.from(cleaned).slice(0, 255).join("").trim();
  return capped || "attachment";
}

/**
 * A blocked extension anywhere in the name blocks the upload, so "invoice.php.png" is refused too.
 * The PHP checked only the last extension.
 */
export function findBlockedExtension(filename: string): string | null {
  const segments = filename.toLowerCase().split(".").slice(1);
  return segments.find((segment) => BLOCKED_ATTACHMENT_EXTENSIONS.includes(segment)) ?? null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));

/** Returns the binary type the leading bytes belong to, or null when no known signature matches. */
export function sniffBinaryType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(bytes, ascii("%PDF-"))) return "application/pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (startsWith(bytes, ascii("OggS"))) return "audio/ogg";
  if (startsWith(bytes, ascii("ID3")) || startsWith(bytes, [0xff, 0xfb]) || startsWith(bytes, [0xff, 0xf3])) {
    return "audio/mpeg";
  }
  if (startsWith(bytes, ascii("ftyp"), 4)) return "video/mp4";
  return null;
}

/** Text is accepted when the first 8 KiB have no NUL byte and the whole body decodes as UTF-8. */
export function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.subarray(0, 8192).includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** True when the bytes match the declared (already normalised) type. */
export function bytesMatchType(declared: string, bytes: Uint8Array): boolean {
  const entry = ALLOWED_ATTACHMENT_TYPES[declared];
  if (!entry) return false;
  if (entry.kind === "text") return isPlainText(bytes);
  return sniffBinaryType(bytes) === declared;
}

export interface AttachmentUpload {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/** Throws a ChatbotError with the HTTP status a route should answer. Nothing is written before this passes. */
export function validateAttachmentUpload(upload: AttachmentUpload, maxBytes: number = ATTACHMENT_MAX_BYTES): void {
  if (upload.bytes.byteLength === 0) {
    throw new ChatbotError("The attachment is empty.", 422);
  }
  if (upload.bytes.byteLength > maxBytes) {
    throw new ChatbotError("The attachment exceeds the configured size limit.", 413);
  }
  const declared = normaliseContentType(upload.contentType);
  if (!Object.hasOwn(ALLOWED_ATTACHMENT_TYPES, declared)) {
    throw new ChatbotError("This attachment type is not allowed.", 415);
  }
  if (findBlockedExtension(upload.filename) !== null) {
    throw new ChatbotError("This attachment extension is blocked.", 415);
  }
  if (!bytesMatchType(declared, upload.bytes)) {
    throw new ChatbotError("The attachment content does not match its type.", 422);
  }
}

/** Blob-store key for one attachment. Built from the company and a random id only. */
export function attachmentStorageKey(companyId: string, attachmentId: string): string {
  return `${ATTACHMENT_KEY_PREFIX}/${companyId}/${attachmentId}`;
}

export interface AttachmentMetaStore {
  insert(record: AttachmentRecord): Promise<void>;
  /** Returns the live (not soft-deleted) row for this company, or null. */
  find(companyId: string, attachmentId: string): Promise<AttachmentRecord | null>;
  markDeleted(companyId: string, attachmentId: string, at: Date): Promise<boolean>;
}

export interface AttachmentBlobStore {
  write(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
}

export interface AttachmentServiceDeps {
  meta: AttachmentMetaStore;
  blobs: AttachmentBlobStore;
  /** HMAC key for download links. Read from the environment by the caller. Missing or short means construction throws. */
  signingKey: string;
  /** Path that serves downloads. The route verifies the token and resolves companyId from the session. */
  downloadPath?: string;
  maxBytes?: number;
  now?: () => Date;
  newId?: () => string;
}

export interface DownloadToken {
  expires: number;
  signature: string;
}

export class AttachmentService implements AttachmentStore {
  private readonly meta: AttachmentMetaStore;
  private readonly blobs: AttachmentBlobStore;
  private readonly signingKey: string;
  private readonly downloadPath: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: AttachmentServiceDeps) {
    if (typeof deps.signingKey !== "string" || deps.signingKey.length < SIGNING_KEY_MIN_LENGTH) {
      // Fails closed. The message names the variable only, never the value.
      throw new Error("Attachment signing key is missing or too short (CHATBOT_SECRET_KEY, at least 32 characters).");
    }
    this.meta = deps.meta;
    this.blobs = deps.blobs;
    this.signingKey = deps.signingKey;
    this.downloadPath = deps.downloadPath ?? "/api/chatbot/attachments";
    this.maxBytes = deps.maxBytes ?? ATTACHMENT_MAX_BYTES;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  async put(
    companyId: string,
    input: { filename: string; contentType: string; bytes: Uint8Array },
  ): Promise<AttachmentRecord> {
    const cid = requireCompanyId(companyId);
    validateAttachmentUpload(input, this.maxBytes);

    const id = this.newId();
    const storageKey = attachmentStorageKey(cid, id);
    const record: AttachmentRecord = {
      id,
      companyId: cid,
      filename: sanitiseFilename(input.filename),
      contentType: normaliseContentType(input.contentType),
      sizeBytes: input.bytes.byteLength,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      storageKey,
      createdAt: this.now(),
    };

    await this.blobs.write(storageKey, input.bytes);
    try {
      await this.meta.insert(record);
    } catch (error) {
      await this.blobs.remove(storageKey).catch(() => undefined);
      throw error;
    }
    return record;
  }

  async get(companyId: string, attachmentId: string): Promise<AttachmentRecord | null> {
    const cid = requireCompanyId(companyId);
    if (!attachmentId) return null;
    const row = await this.meta.find(cid, attachmentId);
    return row && row.companyId === cid ? row : null;
  }

  async readUrl(companyId: string, attachmentId: string, ttlSeconds: number): Promise<string | null> {
    const cid = requireCompanyId(companyId);
    const row = await this.get(cid, attachmentId);
    if (!row) return null;
    const ttl = clampTtl(ttlSeconds);
    const expires = Math.floor(this.now().getTime() / 1000) + ttl;
    const signature = this.sign(cid, row.id, expires);
    return `${this.downloadPath}/${encodeURIComponent(row.id)}?expires=${expires}&sig=${signature}`;
  }

  /** Checks the token is untampered, unexpired, and that the row belongs to companyId. */
  async verifyDownload(companyId: string, attachmentId: string, token: DownloadToken): Promise<boolean> {
    const cid = requireCompanyId(companyId);
    if (!attachmentId || !Number.isSafeInteger(token.expires)) return false;
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (token.expires < nowSeconds || token.expires - nowSeconds > DOWNLOAD_TTL_MAX_SECONDS) return false;
    const expected = this.sign(cid, attachmentId, token.expires);
    if (!constantTimeEqual(expected, token.signature)) return false;
    return (await this.get(cid, attachmentId)) !== null;
  }

  async openDownload(
    companyId: string,
    attachmentId: string,
    token: DownloadToken,
  ): Promise<{ record: AttachmentRecord; bytes: Uint8Array } | null> {
    if (!(await this.verifyDownload(companyId, attachmentId, token))) return null;
    const record = await this.get(companyId, attachmentId);
    if (!record) return null;
    const bytes = await this.blobs.read(record.storageKey);
    return bytes ? { record, bytes } : null;
  }

  async delete(companyId: string, attachmentId: string): Promise<boolean> {
    const cid = requireCompanyId(companyId);
    const row = await this.get(cid, attachmentId);
    if (!row) return false;
    const marked = await this.meta.markDeleted(cid, row.id, this.now());
    if (marked) await this.blobs.remove(row.storageKey);
    return marked;
  }

  private sign(companyId: string, attachmentId: string, expires: number): string {
    return createHmac("sha256", this.signingKey)
      .update(`${companyId}\n${attachmentId}\n${expires}`)
      .digest("base64url");
  }
}

function clampTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds)) return 60;
  return Math.min(DOWNLOAD_TTL_MAX_SECONDS, Math.max(1, Math.floor(ttlSeconds)));
}

function constantTimeEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
