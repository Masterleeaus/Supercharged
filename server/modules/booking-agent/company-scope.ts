import { isCompanyId } from '../../infrastructure/database/tenant-context.ts';

/**
 * Every booking operation needs a companyId. It comes from the verified caller, never
 * from tool input. Anything that is not a non-empty string is rejected before any
 * port is called.
 */
export function assertCompanyId(companyId: unknown): asserts companyId is string {
  if (!isCompanyId(companyId)) {
    throw new TypeError('booking-agent: companyId is required');
  }
}
