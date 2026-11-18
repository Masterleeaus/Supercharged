/**
 * Adapter from the ai-runtime guardrail (server/services/ai-runtime/guardrail.ts) to a VoltAgent input
 * guardrail. The screening rules stay in guardrail.ts. This adapter only changes the shape.
 *
 * Shapes are checked against @voltagent/core 2.11.1 (dist/index.d.ts): an input guardrail receives
 * InputGuardrailArgs (inputText, context: OperationContext) and returns GuardrailBaseResult
 * ({ pass, action?, message? }). The local types below mirror only the fields this adapter uses, so
 * the server does not need the VoltAgent package at compile time.
 *
 * Tenant: read from OperationContext.context under VOLTAGENT_COMPANY_KEY. The app sets that key when it
 * starts an operation. Text is never used as the tenant.
 *
 * Fail closed: a missing or invalid tenant, a verdict that is not exactly { pass: true }, or a thrown
 * error all return { pass: false, action: 'block' }.
 */
import type { GuardrailContract, GuardrailVerdict } from '../../../services/ai-runtime/guardrail.ts';
import { tryCompanyId } from '../../../services/ai-runtime/company.ts';

export const VOLTAGENT_COMPANY_KEY = 'companyId';

/** Subset of VoltAgent OperationContext used here. */
export interface VoltOperationContextLike {
  context: Map<string | symbol, unknown>;
}

/** Subset of VoltAgent InputGuardrailArgs used here. */
export interface VoltInputGuardrailArgsLike {
  inputText: string;
  context: VoltOperationContextLike;
}

/** Subset of VoltAgent GuardrailBaseResult used here. */
export interface VoltGuardrailResultLike {
  pass: boolean;
  action: 'allow' | 'block';
  message?: string;
}

export type VoltInputGuardrail = (args: VoltInputGuardrailArgsLike) => Promise<VoltGuardrailResultLike>;

const BLOCK = (message: string): VoltGuardrailResultLike => ({ pass: false, action: 'block', message });

export function toVoltGuardrail(guardrail: GuardrailContract): VoltInputGuardrail {
  return async (args) => {
    const companyId = tryCompanyId(args?.context?.context?.get(VOLTAGENT_COMPANY_KEY));
    if (companyId === null) return BLOCK('blocked: missing or invalid tenant');
    let verdict: GuardrailVerdict | unknown;
    try {
      verdict = await guardrail.evaluate({
        companyId,
        text: typeof args.inputText === 'string' ? args.inputText : '',
        tool: null,
        params: {},
        context: { stage: 'input' },
      });
    } catch {
      return BLOCK('blocked: guardrail error');
    }
    if (verdict && typeof verdict === 'object' && (verdict as GuardrailVerdict).pass === true) {
      return { pass: true, action: 'allow' };
    }
    const reason = verdict && typeof verdict === 'object' && typeof (verdict as GuardrailVerdict).reason === 'string'
      ? (verdict as GuardrailVerdict).reason as string
      : 'blocked by guardrail';
    return BLOCK(reason);
  };
}
