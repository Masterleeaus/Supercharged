/**
 * Workforce role catalogue: the single schema every role definition follows.
 *
 * A role is pure data. It describes what a workforce agent is for, how it may
 * act, which tools it may call, and what it must refuse. It never carries
 * company data: `companyScope` is fixed to "required" and the company is bound
 * at runtime, not in the file.
 *
 * See SCHEMA.md in this directory for the field-by-field contract.
 */
import { z } from "zod";
import { isAlwaysApproval } from "../runtime/always-approval.ts";

export const VERTICALS = [
  "cleaning",
  "pool",
  "garden",
  "pest",
  "plumbing",
  "electrical",
  "hvac",
  "handyman",
  "locksmith",
  "painting",
  "general_field_service",
  "cross_vertical",
] as const;

export const CATEGORIES = [
  "reception",
  "sales",
  "booking",
  "scheduling",
  "jobs",
  "customer_care",
  "billing",
  "collections",
  "quotes",
  "marketing",
  "compliance",
  "hr",
  "operations",
  "reporting",
] as const;

export const CHANNELS = ["voice", "chat", "sms", "email", "whatsapp", "web"] as const;

/** Ordered from most to least restrictive. */
export const AUTONOMY_LEVELS = [
  "assist",
  "suggest",
  "auto",
  "predictive",
] as const;

export const TOOL_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

/** Access class per tool. A tool with no entry is treated as write (fail closed). */
export const TOOL_ACCESS_LEVELS = ["read", "write"] as const;

/**
 * The 8 agent presets in server/seed-agent-templates.ts (category "agent_preset").
 * The test suite re-reads that file and fails if this list drifts.
 */
export const DESK_PRESET_NAMES = [
  "Virtual Receptionist Agent",
  "Appointment Setter Agent",
  "Lead Qualification Agent",
  "Survey & Feedback Agent",
  "Customer Service Agent",
  "Outbound Sales Agent",
  "Debt Collection Agent",
  "Event Registration Agent",
] as const;

/**
 * Native workforce agent keys from
 * packages/titan-platform/src/workforce-native/contracts.ts in the Field repo
 * (TitanNativeWorkforceAgentKey). business_ops is the canonical business-truth
 * owner, not a workforce role, so it is not listed.
 */
export const FIELD_NATIVE_ROLE_IDS = [
  "reception",
  "sales",
  "booking",
  "scheduling",
  "jobs",
  "customer_care",
] as const;

export type Vertical = (typeof VERTICALS)[number];
export type Category = (typeof CATEGORIES)[number];
export type Channel = (typeof CHANNELS)[number];
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];
export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];

/** Higher rank = more autonomy. A critical tool must sit at or below auto. */
export const AUTONOMY_RANK: Readonly<Record<Autonomy, number>> = {
  assist: 0,
  suggest: 1,
  auto: 2,
  predictive: 3,
};

export const ROLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const TOOL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/** The only placeholders a systemPrompt may use. Both must appear. */
export const PROMPT_PLACEHOLDERS = ["company_name", "vertical"] as const;

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

type SecretRule = { label: string; pattern: RegExp };

/** Literal-value rules for systemPrompt. Matches are never echoed back in errors. */
export const LITERAL_RULES: readonly SecretRule[] = [
  {
    label: "email address",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
  },
  {
    // Starts with + or a leading 0 (or (0x)), then lazily runs to the first
    // digit not followed by a digit. findLiteralValues keeps matches with 8 to
    // 15 digits, so dates and times such as 2026-11-02 or 09:00 do not match.
    label: "phone number",
    pattern: /(?<![\w])(?:\+|\(0?\d{1,2}\)|0)[\d\s().-]{7,}?\d(?!\d)/,
  },
  { label: "API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { label: "API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: "API key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "API key", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: "API key", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  {
    label: "API key",
    pattern: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-/+.]{16,}/i,
  },
];

/** Returns the labels of literal values found in text (e.g. "phone number"). Matched text is never returned. */
export function findLiteralValues(text: string): string[] {
  const found: string[] = [];
  for (const rule of LITERAL_RULES) {
    const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const global = new RegExp(rule.pattern.source, flags);
    for (const match of text.matchAll(global)) {
      if (rule.label === "phone number") {
        const digits = (match[0].match(/\d/g) ?? []).length;
        if (digits < 8 || digits > 15) continue;
      }
      if (!found.includes(rule.label)) found.push(rule.label);
      break;
    }
  }
  return found;
}

function hasDuplicates<T>(items: readonly T[]): boolean {
  return new Set(items).size !== items.length;
}

const kebabId = z
  .string()
  .min(1)
  .max(64)
  .regex(ROLE_ID_PATTERN, "must be kebab-case, e.g. pool-service-scheduler");

const toolId = z
  .string()
  .min(1)
  .max(80)
  .regex(TOOL_ID_PATTERN, "must be lowercase dotted or kebab id, e.g. booking_requests.create");

const shortText = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Structural shape. Cross-field rules live in RoleDefinitionSchema below. */
export const RoleDefinitionBaseSchema = z
  .object({
    id: kebabId,
    name: shortText(3, 80),
    description: shortText(20, 400),
    verticals: z
      .array(z.enum(VERTICALS))
      .min(1)
      .max(12)
      .refine((items) => !hasDuplicates(items), "must not contain duplicates"),
    category: z.enum(CATEGORIES),
    systemPrompt: z.string().min(80).max(8000),
    channels: z
      .array(z.enum(CHANNELS))
      .min(1)
      .refine((items) => !hasDuplicates(items), "must not contain duplicates"),
    autonomy: z.enum(AUTONOMY_LEVELS).default("assist"),
    tools: z
      .array(toolId)
      .max(60)
      .refine((items) => !hasDuplicates(items), "must not contain duplicates"),
    toolRisk: z.record(toolId, z.enum(TOOL_RISK_LEVELS)),
    toolAccess: z.record(toolId, z.enum(TOOL_ACCESS_LEVELS)).default({}),
    guardrails: z.array(shortText(10, 300)).min(1).max(30),
    handoffTo: z
      .array(kebabId)
      .max(20)
      .default([])
      .refine((items) => !hasDuplicates(items), "must not contain duplicates"),
    kpis: z.array(shortText(3, 160)).min(1).max(20),
    sourceRef: z.union([
      z.literal("new"),
      z.enum(DESK_PRESET_NAMES),
      z.enum(FIELD_NATIVE_ROLE_IDS),
    ]),
    companyScope: z.literal("required"),
  })
  .strict();

export const RoleDefinitionSchema = RoleDefinitionBaseSchema.superRefine((role, ctx) => {
  // Every tool needs a risk level, and every risk entry must name a listed tool.
  for (const tool of role.tools) {
    if (!(tool in role.toolRisk)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolRisk", tool],
        message: `missing risk level for tool "${tool}"`,
      });
    }
  }
  for (const tool of Object.keys(role.toolRisk)) {
    if (!role.tools.includes(tool)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolRisk", tool],
        message: `toolRisk names "${tool}", which is not in tools`,
      });
    }
  }

  // A critical tool forces autonomy to auto or stricter. Under auto, the ladder holds every critical
  // action for a verified owner approval (authority-ladder.ts), so critical tools are allowed there.
  const hasCritical = Object.values(role.toolRisk).includes("critical");
  if (hasCritical && AUTONOMY_RANK[role.autonomy] > AUTONOMY_RANK.auto) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["autonomy"],
      message: `a critical-risk tool requires autonomy auto or stricter, got "${role.autonomy}"`,
    });
  }

  // Owner rule: money, customer sends and deletes always need owner approval. Each such tool must be
  // critical, so the ladder holds it under auto, and it can never be declared read.
  for (const tool of role.tools) {
    if (!isAlwaysApproval(tool)) continue;
    if (role.toolRisk[tool] !== "critical") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolRisk", tool],
        message: `owner-approval tool "${tool}" must have toolRisk "critical"`,
      });
    }
    if (role.toolAccess[tool] === "read") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolAccess", tool],
        message: `owner-approval tool "${tool}" cannot be declared read`,
      });
    }
  }

  // toolAccess may only name tools the role declares.
  for (const tool of Object.keys(role.toolAccess)) {
    if (!role.tools.includes(tool)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolAccess", tool],
        message: `toolAccess names "${tool}", which is not in tools`,
      });
    }
  }

  if (role.handoffTo.includes(role.id)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["handoffTo"],
      message: "a role cannot hand off to itself",
    });
  }

  // systemPrompt: required placeholders, no unknown placeholders, no literal values.
  const used = new Set<string>();
  for (const match of role.systemPrompt.matchAll(PLACEHOLDER_PATTERN)) {
    used.add(match[1]);
    if (!(PROMPT_PLACEHOLDERS as readonly string[]).includes(match[1])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["systemPrompt"],
        message: `unknown placeholder "{{${match[1]}}}"; allowed: ${PROMPT_PLACEHOLDERS.join(", ")}`,
      });
    }
  }
  for (const required of PROMPT_PLACEHOLDERS) {
    if (!used.has(required)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["systemPrompt"],
        message: `systemPrompt must use the placeholder {{${required}}}`,
      });
    }
  }
  for (const label of findLiteralValues(role.systemPrompt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["systemPrompt"],
      message: `systemPrompt contains a literal ${label}; use a placeholder or remove it`,
    });
  }
});

export type RoleDefinition = z.output<typeof RoleDefinitionSchema>;
export type RoleInput = z.input<typeof RoleDefinitionSchema>;
