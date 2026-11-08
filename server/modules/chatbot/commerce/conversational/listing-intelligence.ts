/**
 * Listing intelligence: drafts marketplace listing text from canonical product data and scans it for policy problems.
 *
 * OUTPUT ONLY. This module can compose, scan, and save a proposal. It has no publish, write, or push function, and
 * it never calls a marketplace. Publishing belongs to the marketplace write path, behind its own flag
 * (CHATBOT_MARKETPLACE_WRITE_ENABLED) and approval. The proposal status is only "ready" or "blocked".
 *
 * Port of ListingIntelligenceRuntime.php (generateRewrite and analyse), MarketplaceListingComposer.php,
 * ListingComplianceScanner.php, ClaimEvidenceValidator.php, and BrandVoiceGuide.php.
 */
import { createHash } from "node:crypto";
import { CommerceError } from "./errors.ts";

export const LISTING_PROVIDERS = ["amazon", "ebay", "etsy", "generic"] as const;
export type ListingProvider = (typeof LISTING_PROVIDERS)[number];

export interface ProductContent {
  companyId: string;
  chatbotId: string;
  productId: number | null;
  canonicalName: string;
  brand: string;
  summary: string;
  features: string[];
  attributes: Record<string, unknown>;
  claims: { claim: string; evidenceRefs: string[] }[];
  semanticTags: string[];
}

export interface BrandGuide {
  forbiddenTerms: string[];
  preferredTerms: string[];
}

export interface ComplianceRule {
  code: string;
  severity: "info" | "warning" | "block";
  terms: string[];
  fieldScopes: string[];
  message: string;
  remediation: string;
}

export interface Finding {
  code: string;
  severity: "info" | "warning" | "block";
  field: string;
  matchedValue: string;
  message: string;
  remediation: string;
}

export interface ScanResult {
  findings: Finding[];
  blockingCount: number;
  warningCount: number;
  publishable: boolean;
}

export interface ListingProposal {
  id: string;
  companyId: string;
  chatbotId: string;
  provider: ListingProvider;
  productId: number | null;
  sourceHash: string;
  status: "ready" | "blocked";
  proposedContent: Record<string, unknown>;
  findings: Finding[];
  proposalHash: string;
  createdAt: Date;
}

export interface ListingStore {
  /** Active rules for this provider, the generic provider, and this chatbot (or company-wide). */
  rules(companyId: string, chatbotId: string, provider: ListingProvider): Promise<ComplianceRule[]>;
  /** Saves output only. The status column accepts "ready" or "blocked" and nothing else. */
  saveProposal(proposal: ListingProposal): Promise<void>;
}

export interface ListingDeps {
  store: ListingStore;
  now: () => Date;
  newId: () => string;
}

const DEFAULT_RULES: ComplianceRule[] = [
  {
    code: "unsupported_health_claim",
    severity: "block",
    terms: ["cure", "treat disease", "prevent disease"],
    fieldScopes: ["title", "description", "bullet_points"],
    message: "Health or disease claims require explicit evidence and marketplace permission.",
    remediation: "Remove the claim or attach approved evidence.",
  },
  {
    code: "absolute_guarantee",
    severity: "warning",
    terms: ["guaranteed", "100% effective", "best ever"],
    fieldScopes: ["title", "description", "bullet_points"],
    message: "Absolute promotional claims may be misleading.",
    remediation: "Use specific, supportable product facts.",
  },
];

export function defaultComplianceRules(): ComplianceRule[] {
  return DEFAULT_RULES.map((r) => ({ ...r, terms: [...r.terms], fieldScopes: [...r.fieldScopes] }));
}

function cut(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

function clean(value: string, guide: BrandGuide): string {
  let out = value;
  for (const term of guide.forbiddenTerms) {
    const t = term.trim();
    if (t !== "") out = out.split(new RegExp(escapeRegExp(t), "gi")).join("");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Port of MarketplaceListingComposer::compose. Pure. Output is copy only: no ids, prices, or stock. */
export function composeListing(provider: ListingProvider, product: Pick<ProductContent, "canonicalName" | "brand" | "summary" | "features" | "attributes">, guide: BrandGuide): Record<string, unknown> {
  const name = product.canonicalName.trim() || "Product";
  const brand = product.brand.trim();
  const features = product.features.map((f) => f.trim()).filter((f) => f !== "");
  const prefix = brand !== "" && !name.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${name}` : name;
  const description = clean([product.summary.trim(), features.map((f) => `• ${f}`).join("\n")].filter((s) => s !== "").join("\n\n"), guide);
  const title = (limit: number) => cut(clean(prefix, guide), limit);

  switch (provider) {
    case "amazon":
      return {
        title: title(200),
        bullet_points: features.slice(0, 5).map((f) => cut(clean(f, guide), 250)),
        description: cut(description, 2000),
        attributes: product.attributes,
      };
    case "ebay":
      return { title: title(80), description: cut(description, 4000), item_specifics: product.attributes };
    case "etsy": {
      const tagSource = [...features, ...Object.keys(product.attributes)];
      const tags = [...new Set(tagSource.map((v) => cut(v.trim().toLowerCase(), 20)).filter((v) => v !== ""))].slice(0, 13);
      return { title: title(140), description: cut(description, 5000), tags, attributes: product.attributes };
    }
    default:
      return { title: title(200), description: cut(description, 5000), features: features.slice(0, 20), attributes: product.attributes };
  }
}

function flatten(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== "object") return [String(value)];
  return Object.values(value as Record<string, unknown>).flatMap(flatten);
}

/** Port of ListingComplianceScanner::scan. Matches are case-insensitive substring checks, as in the PHP. */
export function scanListing(content: Record<string, unknown>, rules: readonly ComplianceRule[], guide: BrandGuide): ScanResult {
  const fields: Record<string, string> = {};
  for (const [field, value] of Object.entries(content)) {
    fields[field] = typeof value === "object" && value !== null ? flatten(value).join(" ").toLowerCase() : String(value ?? "").toLowerCase();
  }
  const found = new Map<string, Finding>();
  const add = (f: Finding) => found.set(`${f.code}|${f.field}|${f.matchedValue}`, f);

  for (const rule of rules) {
    const scopes = rule.fieldScopes.length > 0 ? rule.fieldScopes : Object.keys(fields);
    for (const scope of scopes) {
      const haystack = fields[scope] ?? "";
      for (const term of rule.terms) {
        const needle = term.trim().toLowerCase();
        if (needle !== "" && haystack.includes(needle)) {
          add({ code: rule.code, severity: rule.severity, field: scope, matchedValue: needle, message: rule.message, remediation: rule.remediation });
        }
      }
    }
  }
  for (const term of guide.forbiddenTerms) {
    const needle = term.trim().toLowerCase();
    if (needle === "") continue;
    for (const [field, haystack] of Object.entries(fields)) {
      if (haystack.includes(needle)) {
        add({ code: "brand_forbidden_term", severity: "warning", field, matchedValue: needle, message: "This wording conflicts with the saved brand voice.", remediation: "Replace it with approved brand language." });
      }
    }
  }
  const findings = [...found.values()];
  const blockingCount = findings.filter((f) => f.severity === "block").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  return { findings, blockingCount, warningCount, publishable: blockingCount === 0 };
}

/** Port of ClaimEvidenceValidator::validate. A claim with no evidence reference is unsupported. */
export function validateClaims(claims: readonly { claim: string; evidenceRefs: readonly string[] }[]): { unsupportedCount: number; unsupported: string[] } {
  const unsupported = claims
    .filter((c) => c.claim.trim() !== "")
    .filter((c) => c.evidenceRefs.every((ref) => ref.trim() === ""))
    .map((c) => c.claim.trim());
  return { unsupportedCount: unsupported.length, unsupported };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function createListingIntelligence(deps: ListingDeps) {
  return {
    /** Scans an existing listing snapshot. Read only. Saves nothing. */
    async analyse(companyId: string, chatbotId: string, provider: ListingProvider, listing: Record<string, unknown>, guide: BrandGuide, claims: ProductContent["claims"] = []) {
      const rules = [...defaultComplianceRules(), ...(await deps.store.rules(companyId, chatbotId, provider))];
      const scan = scanListing(listing, rules, guide);
      const evidence = validateClaims(claims);
      if (evidence.unsupportedCount > 0) {
        scan.findings.push({ code: "unsupported_product_claim", severity: "block", field: "claims", matchedValue: String(evidence.unsupportedCount), message: "One or more product claims have no evidence reference.", remediation: "Attach evidence or remove the unsupported claim." });
        scan.blockingCount += 1;
        scan.publishable = false;
      }
      return { status: "analysed" as const, sourceHash: stableHash(listing), findings: scan.findings, blockingCount: scan.blockingCount, warningCount: scan.warningCount, publishable: scan.publishable };
    },

    /** Drafts listing copy from canonical product data and saves it as a proposal. Never publishes. */
    async generateRewrite(companyId: string, chatbotId: string, provider: ListingProvider, product: ProductContent, guide: BrandGuide): Promise<ListingProposal> {
      if (product.companyId !== companyId || product.chatbotId !== chatbotId) {
        throw new CommerceError("not_found", "The product profile was not found.");
      }
      if (product.canonicalName.trim() === "") throw new CommerceError("validation", "A canonical product name is required.", { canonical_name: "required" });
      const content = composeListing(provider, product, guide);
      const rules = [...defaultComplianceRules(), ...(await deps.store.rules(companyId, chatbotId, provider))];
      const scan = scanListing(content, rules, guide);
      const evidence = validateClaims(product.claims);
      if (evidence.unsupportedCount > 0) {
        scan.findings.push({ code: "unsupported_product_claim", severity: "block", field: "claims", matchedValue: String(evidence.unsupportedCount), message: "Generated copy relies on unsupported product claims.", remediation: "Add evidence references or remove those claims." });
        scan.blockingCount += evidence.unsupportedCount;
        scan.publishable = false;
      }
      const sourceHash = stableHash({ name: product.canonicalName, brand: product.brand, summary: product.summary, features: product.features, attributes: product.attributes, claims: product.claims });
      const proposalHash = stableHash([sourceHash, content, scan.findings]);
      const proposal: ListingProposal = {
        id: deps.newId(),
        companyId,
        chatbotId,
        provider,
        productId: product.productId,
        sourceHash,
        status: scan.publishable ? "ready" : "blocked",
        proposedContent: content,
        findings: scan.findings,
        proposalHash,
        createdAt: deps.now(),
      };
      await deps.store.saveProposal(proposal);
      return proposal;
    },
  };
}
