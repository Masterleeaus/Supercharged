/**
 * Shared types and programmer-error class for the Desk AI runtime.
 *
 * Ported from TitanPro Modules/TitanCore/AI (see PORT-MAP.md). Pure TypeScript: no I/O, no env reads,
 * no provider keys. Operational failures (provider down, guardrail hit, tool refused) are returned as
 * result objects. Only invalid configuration or invalid caller input throws AiRuntimeError.
 */

/** Tenant identifier. Always normalised to a string by requireCompanyId(). */
export type CompanyId = string;

export type AiRuntimeErrorCode = 'company_id_required' | 'company_id_invalid' | 'config_invalid' | 'input_invalid';

export class AiRuntimeError extends Error {
  readonly code: AiRuntimeErrorCode;

  constructor(code: AiRuntimeErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AiRuntimeError';
    this.code = code;
  }
}
