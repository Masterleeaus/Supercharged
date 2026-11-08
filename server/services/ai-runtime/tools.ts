/**
 * Tool execution. Ported from TitanPro:
 *   - Modules/TitanCore/AI/ToolExecutor.php (allowlist, manifest lookup, validation, dry run, timeout, audit)
 *   - Modules/TitanCore/AI/ToolPermissionGate.php (tool -> permission map)
 *   - Modules/TitanCore/AI/ValueObjects/ToolResult.php (result envelope)
 *   - Modules/TitanCore/AI/ToolAuditWriter.php (audit entry fields, via ToolExecutor's writeAudit)
 *
 * Pipeline per call: companyId check, allowlist, manifest lookup, permission check, input validation,
 * dry run, timed execution, one audit entry.
 *
 * Changes from TitanPro (see PORT-MAP.md):
 * - Failures return a ToolResult with ok: false and an error_code. TitanPro throws, and the pipeline then
 *   has no normalised result to return.
 * - The allowlist is required. TitanPro defaults to '*' (allow everything).
 * - Unlisted tools are denied by the permission gate. TitanPro allows them.
 * - A tool with a failed input check is audited. TitanPro throws before the audit write.
 * - A timed-out call is audited once. TitanPro writes the timed_out entry twice.
 * - On timeout the handler's AbortSignal is aborted. TitanPro's SIGALRM handler is a no-op, so a hung
 *   handler is never stopped and the timeout check runs only after the handler returns.
 * - Handlers are functions in the manifest. TitanPro instantiates handler classes named in data.
 *
 * The handler must honour `signal` to stop real work. A handler that ignores it keeps running in the
 * background after the timeout, so the result is not a guarantee that its side effects stopped.
 */
import { createHash } from 'node:crypto';
import { requireCompanyId } from './company.ts';
import { AiRuntimeError, type CompanyId } from './types.ts';

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export type ToolStatus = 'success' | 'dry_run' | 'blocked' | 'failed' | 'timed_out';

export type ToolErrorCode =
  | 'tool_not_allowed'
  | 'tool_handler_not_found'
  | 'tool_permission_denied'
  | 'tool_input_invalid'
  | 'tool_timed_out'
  | 'tool_failed';

export interface ToolContext {
  companyId: CompanyId;
  userId?: string | number | null;
  /** The acting user. Passed to the permission check, never to the handler. */
  user?: unknown;
  dryRun?: boolean;
}

export interface ToolHandlerCall {
  companyId: CompanyId;
  signal: AbortSignal;
}

export type ToolHandler = (params: Record<string, unknown>, call: ToolHandlerCall) => unknown | Promise<unknown>;

export interface ToolDefinition {
  handler: ToolHandler;
  /** Field name to rules string, for example { email: 'required|string' }. Only `required` is enforced, as in TitanPro. */
  input_schema?: Record<string, string>;
}

export type ToolManifest = Record<string, ToolDefinition>;

export type ToolPermissionCheck = (toolName: string, context: ToolContext) => boolean | Promise<boolean>;

export interface ToolAuditEntry {
  tool: string;
  company_id: CompanyId;
  user_id: string | number | null;
  input_hash: string;
  status: ToolStatus;
  duration_ms: number;
  error: string | null;
}

export interface ToolResult {
  ok: boolean;
  tool: string;
  data: Record<string, unknown>;
  message: string;
  warnings: string[];
  audit_ref: string | null;
  error_code: ToolErrorCode | null;
}

export interface ToolExecutorOptions {
  manifest: ToolManifest;
  /** Tool names that may run. Required. An empty list runs nothing. */
  allowedTools: readonly string[];
  timeoutMs?: number;
  audit?: (entry: ToolAuditEntry) => void | Promise<void>;
  permissionCheck?: ToolPermissionCheck | null;
}

const TIMED_OUT = Symbol('tool_timed_out');

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function inputHash(params: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(params ?? {}) ?? '').digest('hex');
}

function now(): number {
  return globalThis.performance.now();
}

/** Returns errors keyed by field. Only `required` is checked: a missing key, null, or an empty string fails. */
export function validateToolInput(schema: Record<string, string>, params: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [field, rules] of Object.entries(schema)) {
    const list = String(rules).split('|').map((r) => r.trim());
    if (!list.includes('required')) continue;
    const value = hasOwn(params, field) ? params[field] : undefined;
    if (value === undefined || value === null || value === '') {
      errors[field] = 'This field is required.';
    }
  }
  return errors;
}

export class ToolExecutor {
  private readonly manifest: ToolManifest;
  private readonly allowedTools: readonly string[];
  private readonly timeoutMs: number;
  private readonly audit: ((entry: ToolAuditEntry) => void | Promise<void>) | undefined;
  private readonly permissionCheck: ToolPermissionCheck | null;

  constructor(options: ToolExecutorOptions) {
    if (!Array.isArray(options.allowedTools)) {
      throw new AiRuntimeError('config_invalid', 'allowedTools must be an explicit array of tool names');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new AiRuntimeError('config_invalid', 'timeoutMs must be a positive integer');
    }
    this.manifest = options.manifest ?? {};
    this.allowedTools = [...options.allowedTools];
    this.timeoutMs = timeoutMs;
    this.audit = options.audit;
    this.permissionCheck = options.permissionCheck ?? null;
  }

  async execute(toolName: string, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const companyId = requireCompanyId(context?.companyId);
    const ctx: ToolContext = { ...context, companyId };
    const userId = ctx.userId ?? null;
    const started = now();
    const elapsed = (): number => Math.round(now() - started);
    const record = async (status: ToolStatus, error: string | null): Promise<void> => {
      await this.audit?.({
        tool: toolName,
        company_id: companyId,
        user_id: userId,
        input_hash: inputHash(params),
        status,
        duration_ms: elapsed(),
        error,
      });
    };
    const refuse = (code: ToolErrorCode, message: string, data: Record<string, unknown> = {}): ToolResult => ({
      ok: false,
      tool: toolName,
      data,
      message,
      warnings: [],
      audit_ref: null,
      error_code: code,
    });

    // 1. Allowlist
    if (!this.allowedTools.includes(toolName)) {
      await record('blocked', 'tool_not_allowed');
      return refuse('tool_not_allowed', 'Tool is not allowed.');
    }

    // 2. Manifest lookup
    const definition = hasOwn(this.manifest, toolName) ? this.manifest[toolName] : undefined;
    if (!definition || typeof definition.handler !== 'function') {
      await record('failed', 'tool_handler_not_found');
      return refuse('tool_handler_not_found', 'Tool handler is not registered.');
    }

    // 3. Permission
    if (this.permissionCheck) {
      let permitted = false;
      try {
        permitted = (await this.permissionCheck(toolName, ctx)) === true;
      } catch {
        permitted = false;
      }
      if (!permitted) {
        await record('blocked', 'tool_permission_denied');
        return refuse('tool_permission_denied', 'Permission denied.');
      }
    }

    // 4. Input validation
    const errors = validateToolInput(definition.input_schema ?? {}, params ?? {});
    if (Object.keys(errors).length > 0) {
      await record('blocked', 'tool_input_invalid');
      return refuse('tool_input_invalid', 'Input is invalid.', { errors });
    }

    // 5. Dry run
    if (ctx.dryRun === true) {
      await record('dry_run', null);
      return {
        ok: true,
        tool: toolName,
        data: { dry_run: true, params },
        message: 'dry-run: no side-effects applied',
        warnings: [],
        audit_ref: null,
        error_code: null,
      };
    }

    // 6. Timed execution
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(TIMED_OUT);
      }, this.timeoutMs);
    });

    type Outcome = { ok: true; raw: unknown } | { ok: false; timedOut: boolean; detail: string };
    let outcome: Outcome;
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() => definition.handler(params ?? {}, { companyId, signal: controller.signal })),
        timeout,
      ]);
      outcome = { ok: true, raw };
    } catch (err) {
      outcome = err === TIMED_OUT
        ? { ok: false, timedOut: true, detail: `timeout_after_${this.timeoutMs}ms` }
        : { ok: false, timedOut: false, detail: err instanceof Error ? err.message : String(err) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    // 7. Audit exactly once per attempt
    if (outcome.ok) {
      await record('success', null);
      const raw = outcome.raw;
      const data = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { result: raw };
      return { ok: true, tool: toolName, data, message: 'ok', warnings: [], audit_ref: null, error_code: null };
    }
    if (outcome.timedOut) {
      await record('timed_out', outcome.detail);
      return refuse('tool_timed_out', 'Tool timed out.');
    }
    await record('failed', outcome.detail);
    return refuse('tool_failed', 'Tool failed.');
  }
}

export interface ToolPermissionGateOptions {
  /** Tool name to the permission it requires. */
  requirements: Record<string, string>;
  /** Tools that may run with no permission requirement. Anything not listed here or in requirements is denied. */
  unrestricted?: readonly string[];
  /** Maps the acting user and a permission name to a boolean. Replaces Spatie hasPermissionTo() and Gate::can(). */
  hasPermission: (user: unknown, permission: string) => boolean | Promise<boolean>;
}

/** Default-deny permission gate. Use as ToolExecutor's permissionCheck. */
export function createToolPermissionGate(options: ToolPermissionGateOptions): ToolPermissionCheck {
  const unrestricted = new Set(options.unrestricted ?? []);
  return async (toolName, context) => {
    if (hasOwn(options.requirements, toolName)) {
      if (context.user === undefined || context.user === null) return false;
      return (await options.hasPermission(context.user, options.requirements[toolName])) === true;
    }
    return unrestricted.has(toolName);
  };
}
