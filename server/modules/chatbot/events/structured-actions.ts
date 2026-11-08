/**
 * Structured actions: what the model proposes and what staff or policy approves.
 *
 * - Every kind has an argument schema. Unknown keys and wrong types are refused before anything is stored.
 * - Buttons and forms the bot shows are validated on the server. A customer or staff response is checked
 *   against the same definition before it is accepted.
 * - Kinds in REQUIRES_APPROVAL stay "proposed" until a staff member approves them. Other kinds start "approved".
 * - Every method takes companyId. An action or conversation from another company is reported as absent (null).
 *
 * The PHP runtime (StructuredActionRuntime.php) stores any type and payload. The typed schemas here are new.
 */
import {
  REQUIRES_APPROVAL,
  STRUCTURED_ACTION_KINDS,
  type StructuredActionKind,
  type StructuredActionStatus,
} from "../contracts/index.ts";
import {
  EventsError,
  type ActionButton,
  type ActionFormField,
  type ActionPresentation,
  type ActionRecord,
  type ActionStore,
  type EventsDeps,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------

type FieldRule =
  | { type: "id" }
  | { type: "text"; min: number; max: number }
  | { type: "datetime" }
  | { type: "int"; min: number; max: number }
  | { type: "enum"; values: readonly string[] };

interface ArgField {
  rule: FieldRule;
  required: boolean;
}

const ID: FieldRule = { type: "id" };
const id = (required: boolean): ArgField => ({ rule: ID, required });
const text = (min: number, max: number, required: boolean): ArgField => ({ rule: { type: "text", min, max }, required });
const datetime = (required: boolean): ArgField => ({ rule: { type: "datetime" }, required });
const int = (min: number, max: number, required: boolean): ArgField => ({ rule: { type: "int", min, max }, required });
const choice = (values: readonly string[], required: boolean): ArgField => ({ rule: { type: "enum", values }, required });

/** One schema per kind. Keys are camelCase in stored args. Money is integer minor units. */
export const ACTION_ARG_SCHEMAS: Record<StructuredActionKind, Record<string, ArgField>> = {
  create_booking: {
    serviceId: id(true),
    startsAt: datetime(true),
    customerName: text(0, 200, false),
    notes: text(0, 500, false),
  },
  reschedule_booking: { bookingId: id(true), startsAt: datetime(true) },
  cancel_booking: { bookingId: id(true), reason: text(0, 500, false) },
  add_to_cart: { productId: id(true), variantId: id(false), quantity: int(1, 999, true) },
  quote_checkout: { cartId: id(true) },
  lookup_order: { orderId: id(true) },
  request_refund: { orderId: id(true), amountMinor: int(1, 100_000_000, true), reason: text(1, 500, true) },
  handoff_to_human: { reason: text(1, 500, true), priority: choice(["low", "normal", "high"], false) },
  send_reminder: { bookingId: id(true), message: text(0, 500, false) },
};

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,191}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function checkValue(name: string, rule: FieldRule, value: unknown): unknown {
  switch (rule.type) {
    case "id":
      if (typeof value !== "string" || !ID_PATTERN.test(value)) {
        throw new EventsError("VALIDATION", `${name} must be an id.`);
      }
      return value;
    case "text": {
      if (typeof value !== "string") throw new EventsError("VALIDATION", `${name} must be text.`);
      const trimmed = value.trim();
      if (trimmed.length < rule.min || trimmed.length > rule.max) {
        throw new EventsError("VALIDATION", `${name} must be ${rule.min} to ${rule.max} characters.`);
      }
      return trimmed;
    }
    case "datetime": {
      if (typeof value !== "string" || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
        throw new EventsError("VALIDATION", `${name} must be an ISO 8601 date and time with a zone.`);
      }
      return value;
    }
    case "int":
      if (!Number.isSafeInteger(value) || (value as number) < rule.min || (value as number) > rule.max) {
        throw new EventsError("VALIDATION", `${name} must be a whole number from ${rule.min} to ${rule.max}.`);
      }
      return value;
    case "enum":
      if (typeof value !== "string" || !rule.values.includes(value)) {
        throw new EventsError("VALIDATION", `${name} is not one of the allowed values.`);
      }
      return value;
  }
}

/** Checks args against the kind's schema. Returns a copy holding only known keys. Error messages name keys, never values. */
export function validateActionArgs(kind: StructuredActionKind, args: unknown): Record<string, unknown> {
  if (!STRUCTURED_ACTION_KINDS.includes(kind)) throw new EventsError("VALIDATION", "Unknown action kind.");
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new EventsError("VALIDATION", "Action arguments must be an object.");
  }
  const schema = ACTION_ARG_SCHEMAS[kind];
  const input = args as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(key in schema)) throw new EventsError("VALIDATION", `Unknown argument: ${key}.`);
  }
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema)) {
    const value = input[name];
    if (value === undefined || value === null || value === "") {
      if (field.required) throw new EventsError("VALIDATION", `${name} is required.`);
      continue;
    }
    out[name] = checkValue(name, field.rule, value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Buttons and forms
// ---------------------------------------------------------------------------

const FIELD_TYPES = ["text", "number", "boolean", "choice", "datetime"] as const;
const FORM_NAME = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const BUTTON_ID = /^[a-z0-9_-]{1,64}$/;

/** Checks buttons and form definitions the bot wants to show. Returns a cleaned copy. */
export function validatePresentation(input: unknown): ActionPresentation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EventsError("VALIDATION", "Presentation must be an object.");
  }
  const raw = input as { buttons?: unknown; form?: unknown };
  const out: ActionPresentation = {};

  if (raw.buttons !== undefined) {
    if (!Array.isArray(raw.buttons) || raw.buttons.length < 1 || raw.buttons.length > 5) {
      throw new EventsError("VALIDATION", "Buttons must be a list of 1 to 5 items.");
    }
    const seen = new Set<string>();
    out.buttons = raw.buttons.map((button: unknown): ActionButton => {
      const b = button as Partial<ActionButton>;
      if (typeof b?.id !== "string" || !BUTTON_ID.test(b.id) || seen.has(b.id)) {
        throw new EventsError("VALIDATION", "Each button needs a unique id of letters, digits, _ or -.");
      }
      if (typeof b.label !== "string" || b.label.trim().length < 1 || b.label.trim().length > 60) {
        throw new EventsError("VALIDATION", "Each button label must be 1 to 60 characters.");
      }
      seen.add(b.id);
      return { id: b.id, label: b.label.trim() };
    });
  }

  if (raw.form !== undefined) {
    const form = raw.form as { fields?: unknown };
    if (!form || !Array.isArray(form.fields) || form.fields.length < 1 || form.fields.length > 20) {
      throw new EventsError("VALIDATION", "A form needs 1 to 20 fields.");
    }
    const names = new Set<string>();
    const fields = form.fields.map((field: unknown): ActionFormField => {
      const f = field as Partial<ActionFormField>;
      if (typeof f?.name !== "string" || !FORM_NAME.test(f.name) || names.has(f.name)) {
        throw new EventsError("VALIDATION", "Each form field needs a unique name in camelCase.");
      }
      if (typeof f.label !== "string" || f.label.trim().length < 1 || f.label.trim().length > 120) {
        throw new EventsError("VALIDATION", "Each form field label must be 1 to 120 characters.");
      }
      if (!FIELD_TYPES.includes(f.type as (typeof FIELD_TYPES)[number])) {
        throw new EventsError("VALIDATION", "Unknown form field type.");
      }
      names.add(f.name);
      const cleaned: ActionFormField = { name: f.name, label: f.label.trim(), type: f.type as ActionFormFieldType, required: f.required === true };
      if (f.type === "text") {
        const max = f.maxLength ?? 500;
        if (!Number.isSafeInteger(max) || max < 1 || max > 2000) throw new EventsError("VALIDATION", "Text maxLength must be 1 to 2000.");
        cleaned.maxLength = max;
      }
      if (f.type === "choice") {
        if (!Array.isArray(f.options) || f.options.length < 1 || f.options.length > 20 || f.options.some((o) => typeof o !== "string" || o.trim() === "")) {
          throw new EventsError("VALIDATION", "A choice field needs 1 to 20 non-empty options.");
        }
        cleaned.options = f.options.map((o) => o.trim());
      }
      return cleaned;
    });
    out.form = { fields };
  }

  return out;
}

type ActionFormFieldType = ActionFormField["type"];

/**
 * Checks a customer or staff response to a shown presentation. A button id must be one the bot showed.
 * Form values must match the fields: required ones present, types right, unknown names refused.
 */
export function validatePresentationResponse(
  presentation: ActionPresentation,
  response: { buttonId?: unknown; values?: unknown },
): { buttonId: string | null; values: Record<string, string | number | boolean> } {
  let buttonId: string | null = null;
  if (response.buttonId !== undefined && response.buttonId !== null) {
    const match = presentation.buttons?.find((b) => b.id === response.buttonId);
    if (!match) throw new EventsError("VALIDATION", "That button was not offered.");
    buttonId = match.id;
  }

  const values: Record<string, string | number | boolean> = {};
  const fields = presentation.form?.fields ?? [];
  const input = response.values === undefined ? {} : response.values;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EventsError("VALIDATION", "Form values must be an object.");
  }
  const given = input as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!fields.some((f) => f.name === key)) throw new EventsError("VALIDATION", `Unknown form field: ${key}.`);
  }
  for (const field of fields) {
    const value = given[field.name];
    if (value === undefined || value === null || value === "") {
      if (field.required) throw new EventsError("VALIDATION", `${field.label} is required.`);
      continue;
    }
    switch (field.type) {
      case "text": {
        if (typeof value !== "string" || value.length > (field.maxLength ?? 500)) {
          throw new EventsError("VALIDATION", `${field.label} is too long or not text.`);
        }
        values[field.name] = value.trim();
        break;
      }
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) throw new EventsError("VALIDATION", `${field.label} must be a number.`);
        values[field.name] = value;
        break;
      case "boolean":
        if (typeof value !== "boolean") throw new EventsError("VALIDATION", `${field.label} must be yes or no.`);
        values[field.name] = value;
        break;
      case "choice":
        if (typeof value !== "string" || !(field.options ?? []).includes(value)) {
          throw new EventsError("VALIDATION", `${field.label} is not one of the options.`);
        }
        values[field.name] = value;
        break;
      case "datetime":
        if (typeof value !== "string" || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
          throw new EventsError("VALIDATION", `${field.label} must be a date and time.`);
        }
        values[field.name] = value;
        break;
    }
  }
  return { buttonId, values };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ProposeInput {
  kind: StructuredActionKind;
  args: unknown;
  presentation?: unknown;
  expiresAt?: Date | null;
  idempotencyKey?: string | null;
}

export type ActionExecutor = (
  args: Record<string, unknown>,
  context: { actionId: string; kind: StructuredActionKind },
) => Promise<{ resultRef: string }>;

export interface StructuredActionService {
  propose(companyId: string, conversationId: string, input: ProposeInput): Promise<ActionRecord | null>;
  get(companyId: string, actionId: string): Promise<ActionRecord | null>;
  list(companyId: string, conversationId: string, status?: StructuredActionStatus): Promise<ActionRecord[]>;
  approve(companyId: string, actionId: string, staffId: string): Promise<ActionRecord | null>;
  reject(companyId: string, actionId: string, staffId: string, reason: string | null): Promise<ActionRecord | null>;
  execute(companyId: string, actionId: string, executor: ActionExecutor): Promise<ActionRecord | null>;
  /** Sets "expired" on this company's "proposed" actions created more than maxAgeMs before now. Returns the count. */
  expireStaleProposals(companyId: string, now: Date, maxAgeMs?: number): Promise<number>;
}

const MAX_KEY_LENGTH = 191;
const DEFAULT_EXECUTION_STALE_SECONDS = 300;
/** Owner decision: a proposal that staff have not approved within 24 hours expires. */
export const PROPOSAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function createStructuredActionService(store: ActionStore, deps: EventsDeps): StructuredActionService {
  return {
    async expireStaleProposals(companyId, now, maxAgeMs = PROPOSAL_MAX_AGE_MS) {
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new EventsError("VALIDATION", "Sweep time must be a valid date.");
      if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new EventsError("VALIDATION", "Maximum proposal age must be a positive number.");
      const cutoff = new Date(now.getTime() - maxAgeMs);
      return store.expireProposedBefore(companyId, cutoff, now);
    },

    async propose(companyId, conversationId, input) {
      const kind = input.kind;
      const args = validateActionArgs(kind, input.args);
      const presentation = input.presentation === undefined || input.presentation === null ? null : validatePresentation(input.presentation);
      const now = deps.now();
      if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
        throw new EventsError("VALIDATION", "An action cannot expire in the past.");
      }
      const idempotencyKey = input.idempotencyKey ? input.idempotencyKey.trim() : null;
      if (idempotencyKey && idempotencyKey.length > MAX_KEY_LENGTH) throw new EventsError("VALIDATION", "Idempotency key is too long.");

      if (!(await store.conversationExists(companyId, conversationId))) return null;
      if (idempotencyKey) {
        const existing = await store.findByIdempotencyKey(companyId, conversationId, idempotencyKey);
        if (existing) return existing;
      }

      const requiresApproval = REQUIRES_APPROVAL.includes(kind);
      const action: ActionRecord = {
        id: deps.newId(),
        companyId,
        conversationId,
        kind,
        args,
        // Approval kinds wait for staff. Other kinds are approved by policy, with no approver recorded.
        status: requiresApproval ? "proposed" : "approved",
        requiresApproval,
        approvedBy: null,
        resultRef: null,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: input.expiresAt ?? null,
        idempotencyKey,
        presentation,
        executionToken: null,
        executionStartedAt: null,
      };
      const saved = await store.insertAction(companyId, action);
      if (saved) return saved;
      return idempotencyKey ? store.findByIdempotencyKey(companyId, conversationId, idempotencyKey) : null;
    },

    get(companyId, actionId) {
      return store.getAction(companyId, actionId);
    },

    list(companyId, conversationId, status) {
      return store.listActions(companyId, conversationId, status);
    },

    approve(companyId, actionId, staffId) {
      const now = deps.now();
      return store.mutateAction(companyId, actionId, (action) => {
        if (action.status !== "proposed") {
          throw new EventsError("INVALID_STATE", `Cannot approve an action in ${action.status}.`);
        }
        if (action.expiresAt && action.expiresAt.getTime() <= now.getTime()) {
          throw new EventsError("INVALID_STATE", "This action has expired.");
        }
        return { status: "approved", approvedBy: staffId, updatedAt: now };
      });
    },

    reject(companyId, actionId, staffId, reason) {
      const now = deps.now();
      return store.mutateAction(companyId, actionId, (action) => {
        if (action.status !== "proposed") {
          throw new EventsError("INVALID_STATE", `Cannot reject an action in ${action.status}.`);
        }
        return { status: "rejected", approvedBy: staffId, failureReason: reason?.trim() || null, updatedAt: now };
      });
    },

    async execute(companyId, actionId, executor) {
      const now = deps.now();
      const token = deps.newId();
      // Claim first, so two callers cannot both run the executor for one action.
      const claimed = await store.mutateAction(companyId, actionId, (action) => {
        if (action.status !== "approved") {
          throw new EventsError("INVALID_STATE", `Cannot execute an action in ${action.status}.`);
        }
        const staleBefore = now.getTime() - DEFAULT_EXECUTION_STALE_SECONDS * 1000;
        if (action.executionToken && action.executionStartedAt && action.executionStartedAt.getTime() > staleBefore) {
          throw new EventsError("INVALID_STATE", "This action is already executing.");
        }
        return { executionToken: token, executionStartedAt: now, updatedAt: now };
      });
      if (!claimed) return null;

      let outcome: { resultRef: string } | { failure: string };
      try {
        outcome = await executor(claimed.args, { actionId, kind: claimed.kind });
      } catch (error) {
        // Failure text is fixed. The executor's own message may hold customer data.
        outcome = { failure: error instanceof EventsError ? error.message : "Execution failed." };
      }

      const finishedAt = deps.now();
      return store.mutateAction(companyId, actionId, (action) => {
        if (action.executionToken !== token) return null;
        if ("failure" in outcome) {
          return { status: "failed", failureReason: outcome.failure, executionToken: null, executionStartedAt: null, updatedAt: finishedAt };
        }
        return {
          status: "executed",
          resultRef: outcome.resultRef,
          failureReason: null,
          executionToken: null,
          executionStartedAt: null,
          updatedAt: finishedAt,
        };
      });
    },
  };
}
