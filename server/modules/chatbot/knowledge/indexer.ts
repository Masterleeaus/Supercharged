/**
 * Indexing service for knowledge sources: text, Q&A pairs, uploaded files, URL pages and imported articles.
 * Each source is chunked, embedded through the injected provider, and written with replaceChunks.
 *
 * Port of TrainingService, ChatbotTrainController (train, trainText, trainQa, trainUrl, trainFile) and
 * LinkParser::insertEmbeddings (PHP). Not ported: the demo-mode guard and the per-call credit deduction.
 * Billing and demo gating belong to other slices. See DECISIONS.md.
 *
 * Article CRUD is not here. Articles are read-only inputs, passed in by the caller.
 */
import {
  CONTRACT_FLAGS,
  readFlag as defaultReadFlag,
  type FlagEnv,
  type HttpClient,
  type KnowledgeSource,
  type KnowledgeStorage,
  type ModelProvider,
  type ReadFlag,
} from "../contracts/index.ts";
import { requireCompanyId } from "../chatbot-scope.ts";
import {
  approxTokenCount,
  chunkIdFor,
  chunkText,
  DEFAULT_MAX_TOKENS,
  hashText,
  normalizeText,
  qaText,
} from "./chunking.ts";
import { type EmbeddingModel, embedInputs } from "./embedding.ts";
import { KnowledgeError, safeMessage } from "./errors.ts";
import { crawlSite, DEFAULT_MAX_FETCH_BYTES, htmlToText, type FetchOptions } from "./url-source.ts";
import { type AddressResolver } from "./ssrf.ts";

export const MAX_TITLE_LENGTH = 255;

/** Extracts plain text from binary documents. Injected: the slice ships no PDF or spreadsheet library. */
export interface FileTextExtractor {
  pdf(bytes: Uint8Array): Promise<string>;
  spreadsheet(bytes: Uint8Array): Promise<string>;
}

/** A knowledge-base article, read by the caller from the article owner's table. Never written here. */
export interface KnowledgeArticleInput {
  id: string;
  title: string;
  content: string;
}

export interface KnowledgeIndexerOptions {
  storage: KnowledgeStorage;
  provider: ModelProvider;
  embeddingModel: EmbeddingModel;
  env: FlagEnv;
  readFlag?: ReadFlag;
  http: HttpClient;
  resolve: AddressResolver;
  /** Timeout for each embedding call and each page fetch, in milliseconds. */
  timeoutMs: number;
  fileText?: FileTextExtractor;
  maxTokens?: number;
  maxFetchBytes?: number;
  now?: () => Date;
}

const TEXT_EXTENSIONS = new Set(["txt", "md", "json", "csv"]);
const SPREADSHEET_EXTENSIONS = new Set(["xlsx", "xls"]);

function cleanTitle(title: string, fallback: string): string {
  const value = normalizeText(title).slice(0, MAX_TITLE_LENGTH);
  return value || fallback;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export class KnowledgeIndexer {
  private readonly opts: KnowledgeIndexerOptions;
  private readonly readFlag: ReadFlag;
  private readonly maxTokens: number;
  private readonly now: () => Date;

  constructor(options: KnowledgeIndexerOptions) {
    this.opts = options;
    this.readFlag = options.readFlag ?? defaultReadFlag;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.now = options.now ?? (() => new Date());
  }

  private assertEnabled(): void {
    if (!this.readFlag(CONTRACT_FLAGS.KNOWLEDGE_ENABLED, this.opts.env)) {
      throw new KnowledgeError("disabled", "The knowledge base is turned off for this installation.", 503);
    }
  }

  async addText(companyId: string, chatbotId: string, input: { title: string; content: string }): Promise<KnowledgeSource> {
    const tenant = requireCompanyId(companyId);
    this.assertEnabled();
    const source = await this.opts.storage.insertSource(tenant, {
      chatbotId,
      kind: "text",
      title: cleanTitle(input.title, "Untitled text"),
      uri: null,
    });
    return this.indexText(tenant, source, input.content);
  }

  async addQa(companyId: string, chatbotId: string, input: { question: string; answer: string }): Promise<KnowledgeSource> {
    const tenant = requireCompanyId(companyId);
    this.assertEnabled();
    const source = await this.opts.storage.insertSource(tenant, {
      chatbotId,
      kind: "faq",
      title: cleanTitle(input.question, "Untitled question"),
      uri: null,
    });
    return this.indexText(tenant, source, qaText(input.question, input.answer));
  }

  /** Uploaded file. The uri is the attachment id, so the same attachment is not indexed twice. */
  async addFile(
    companyId: string,
    chatbotId: string,
    input: { title: string; filename: string; attachmentId: string; bytes: Uint8Array },
  ): Promise<KnowledgeSource> {
    const tenant = requireCompanyId(companyId);
    this.assertEnabled();
    const text = await this.extractFile(input.filename, input.bytes);
    const existing = (await this.opts.storage.listSources(tenant, chatbotId)).find(
      (s) => s.kind === "file" && s.uri === input.attachmentId,
    );
    const source =
      existing ??
      (await this.opts.storage.insertSource(tenant, {
        chatbotId,
        kind: "file",
        title: cleanTitle(input.title || input.filename, "Untitled file"),
        uri: input.attachmentId,
      }));
    return this.indexText(tenant, source, text);
  }

  /** Fetches a page, or a page and its same-host links, and indexes each one as a url source. */
  async addUrl(
    companyId: string,
    chatbotId: string,
    input: { url: string; single: boolean },
  ): Promise<KnowledgeSource[]> {
    const tenant = requireCompanyId(companyId);
    this.assertEnabled();
    const fetchOptions: FetchOptions = {
      http: this.opts.http,
      resolve: this.opts.resolve,
      timeoutMs: this.opts.timeoutMs,
      maxBytes: this.opts.maxFetchBytes ?? DEFAULT_MAX_FETCH_BYTES,
    };
    const pages = await crawlSite(input.url, { ...fetchOptions, single: input.single });

    const known = await this.opts.storage.listSources(tenant, chatbotId);
    const out: KnowledgeSource[] = [];
    for (const page of pages) {
      const existing = known.find((s) => s.kind === "url" && s.uri === page.url);
      const source =
        existing ??
        (await this.opts.storage.insertSource(tenant, {
          chatbotId,
          kind: "url",
          title: cleanTitle(page.title, page.url),
          uri: page.url,
        }));
      out.push(await this.indexText(tenant, source, page.text));
    }
    return out;
  }

  /** Imports articles as faq sources. The article table is read by the caller and never written here. */
  async importArticles(
    companyId: string,
    chatbotId: string,
    articles: readonly KnowledgeArticleInput[],
  ): Promise<KnowledgeSource[]> {
    const tenant = requireCompanyId(companyId);
    this.assertEnabled();
    const known = await this.opts.storage.listSources(tenant, chatbotId);
    const out: KnowledgeSource[] = [];
    for (const article of articles) {
      const uri = `article:${article.id}`;
      const existing = known.find((s) => s.kind === "faq" && s.uri === uri);
      const title = cleanTitle(article.title, "Untitled article");
      const source = existing ?? (await this.opts.storage.insertSource(tenant, { chatbotId, kind: "faq", title, uri }));
      const body = /<[a-z][\s\S]*>/i.test(article.content) ? htmlToText(article.content) : article.content;
      out.push(await this.indexText(tenant, source, `${title}\n\n${body}`));
    }
    return out;
  }

  /** Removes a source with its chunks and embeddings. Allowed even when the flag is off, so clean-up always works. */
  async deleteSource(companyId: string, sourceId: string): Promise<boolean> {
    const tenant = requireCompanyId(companyId);
    return this.opts.storage.deleteSource(tenant, sourceId);
  }

  private async extractFile(filename: string, bytes: Uint8Array): Promise<string> {
    const ext = extensionOf(filename);
    if (TEXT_EXTENSIONS.has(ext)) {
      return new TextDecoder("utf-8").decode(bytes);
    }
    if (SPREADSHEET_EXTENSIONS.has(ext)) {
      if (!this.opts.fileText) throw new KnowledgeError("unsupported_content", "Spreadsheet reading is not configured.", 415);
      return this.opts.fileText.spreadsheet(bytes);
    }
    if (ext === "pdf") {
      if (!this.opts.fileText) throw new KnowledgeError("unsupported_content", "PDF reading is not configured.", 415);
      return this.opts.fileText.pdf(bytes);
    }
    throw new KnowledgeError("unsupported_content", "This file type cannot be indexed.", 415);
  }

  /**
   * Chunks, embeds and stores one source's text. Skips the work when the content hash matches the last
   * indexed content. A failure is recorded on the source and returned, not thrown. Old chunks stay in place
   * until the new ones are ready, so a failed re-index never leaves a ready source empty.
   */
  private async indexText(companyId: string, source: KnowledgeSource, raw: string): Promise<KnowledgeSource> {
    const storage = this.opts.storage;
    const text = normalizeText(raw);
    if (!text) {
      return this.recordFailure(companyId, source, "No text was found in this source.");
    }
    const contentHash = hashText(text);
    if (source.status === "ready" && source.contentHash === contentHash) {
      return source;
    }

    try {
      const pieces = chunkText(text, this.maxTokens);
      if (pieces.length === 0) {
        return this.recordFailure(companyId, source, "No text was found in this source.");
      }
      const vectors = await embedInputs(this.opts.provider, companyId, this.opts.embeddingModel, pieces, this.opts.timeoutMs);

      if (source.status !== "ready") {
        await storage.setSourceStatus(companyId, source.id, "indexing", {});
      }

      const chunks = pieces.map((piece, ordinal) => ({
        companyId,
        sourceId: source.id,
        chatbotId: source.chatbotId,
        ordinal,
        text: piece,
        tokenCount: approxTokenCount(piece),
        contentHash: hashText(piece),
        metadata: null,
      }));
      const embeddings = chunks.map((chunk, i) => ({
        chunkId: chunkIdFor(source.id, chunk.ordinal, chunk.contentHash),
        companyId,
        provider: this.opts.embeddingModel.provider,
        model: this.opts.embeddingModel.model,
        dimensions: this.opts.embeddingModel.dimensions,
        vector: vectors[i],
      }));

      const written = await storage.replaceChunks(companyId, source.id, chunks, embeddings);
      if (written !== chunks.length) {
        throw new KnowledgeError("write_failed", "The chunks could not be stored.");
      }
      const updated = await storage.setSourceStatus(companyId, source.id, "ready", {
        contentHash,
        lastError: null,
        lastIndexedAt: this.now(),
      });
      if (!updated) throw new KnowledgeError("not_found", "The source no longer exists.", 404);
      return updated;
    } catch (error) {
      return this.recordFailure(companyId, source, safeMessage(error));
    }
  }

  private async recordFailure(companyId: string, source: KnowledgeSource, message: string): Promise<KnowledgeSource> {
    // A ready source keeps its status, so retrieval keeps serving the last good content.
    const status = source.status === "ready" ? "ready" : "failed";
    const updated = await this.opts.storage.setSourceStatus(companyId, source.id, status, {
      lastError: message.slice(0, 300),
    });
    return updated ?? { ...source, status, lastError: message };
  }
}
