/**
 * Tenant guard. Every runtime entry point calls requireCompanyId() on the companyId it is given.
 * Nothing in this folder reads a company from a request, a session or the environment.
 *
 * Accepts a positive safe integer (TitanPro uses integer company ids) or a string of 1 to 128
 * characters from [A-Za-z0-9_.-] that starts with a letter or digit. Both forms normalise to a string,
 * so 7 and '7' name the same tenant.
 */
import { AiRuntimeError, type CompanyId } from './types.ts';

const COMPANY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function requireCompanyId(value: unknown): CompanyId {
  if (value === undefined || value === null || value === '') {
    throw new AiRuntimeError('company_id_required', 'companyId is required for every AI runtime call');
  }
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return String(value);
    throw new AiRuntimeError('company_id_invalid', 'companyId must be a positive integer or a valid id string');
  }
  if (typeof value === 'string' && COMPANY_ID_PATTERN.test(value)) return value;
  throw new AiRuntimeError('company_id_invalid', 'companyId must be a positive integer or a valid id string');
}

/** Returns the normalised companyId, or null when the value is not a valid tenant id. Never throws. */
export function tryCompanyId(value: unknown): CompanyId | null {
  try {
    return requireCompanyId(value);
  } catch {
    return null;
  }
}
