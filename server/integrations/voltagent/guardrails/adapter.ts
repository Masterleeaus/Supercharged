/**
 * Adapter from the ai-runtime guardrail (server/services/ai-runtime/guardrail.ts) to a
 * VoltAgent-style guardrail function. The screening rules stay in guardrail.ts. This adapter
 * only changes the shape. The VoltAgent guardrail signature is written from docs and is NOT
 * verified against the VoltAgent source, which is not in the repo.
 *
 * Fail closed: anything other than a verdict of exactly { pass: true } blocks.
 *
 * Licence: original TitanZero code. It copies no Mastra or VoltAgent source. See source/mastra-apache-only/README.md.
 */
import type { GuardrailContract, GuardrailContext, GuardrailVerdict } from '../../../services/ai-runtime/guardrail.ts';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';

export interface VoltGuardrailInput {
  companyId: string;
  text: string;
  context?: GuardrailContext;
}

export type VoltGuardrail = (input: VoltGuardrailInput) => Promise<{ pass: boolean; reason?: string }>;

export function toVoltGuardrail(guardrail: GuardrailContract): VoltGuardrail {
  return async (input) => {
    const companyId = requireCompanyId(input.companyId);
    const verdict: GuardrailVerdict | unknown = await guardrail.evaluate({
      companyId,
      text: typeof input.text === 'string' ? input.text : '',
      tool: null,
      params: {},
      context: { stage: input.context ?? 'input' },
    });
    if (verdict && typeof verdict === 'object' && (verdict as GuardrailVerdict).pass === true) {
      return { pass: true };
    }
    const reason = verdict && typeof verdict === 'object' && typeof (verdict as GuardrailVerdict).reason === 'string'
      ? (verdict as GuardrailVerdict).reason
      : 'blocked by guardrail';
    return { pass: false, reason };
  };
}
