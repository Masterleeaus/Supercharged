/**
 * Ordered AI pipeline. Ported from TitanPro Modules/TitanCore/AI/AIOrchestratorPipeline.php.
 *
 * Stages, in order:
 *   1. guardrail   blocks the request before anything else runs
 *   2. retrieval   fetches tenant-scoped context for the text
 *   3. tool        runs one declared tool, if the request names one
 *   4. citation    attaches sources for the retrieved chunks
 *
 * Any stage may be left out. A guardrail block returns at once, and later stages do not run.
 *
 * Changes from TitanPro (see PORT-MAP.md):
 * - The guardrail verdict must be exactly { pass: true }. TitanPro lets a verdict with no `pass` key through.
 * - A request for a tool with no tool executor is refused at stage 'tool'. TitanPro returns tool_result: null
 *   and reports ok: true.
 * - `ok` is false when the tool ran and failed. TitanPro always returned ok: true once it reached the end.
 * - companyId is required and is passed to every stage. TitanPro gives context to the retrieval stage only.
 */
import { requireCompanyId } from './company.ts';
import { evaluateGuardrail, type GuardrailContract } from './guardrail.ts';
import type { RetrievalResult } from './retrieval.ts';
import type { Citation } from './citation.ts';
import type { ToolContext, ToolResult } from './tools.ts';
import type { CompanyId } from './types.ts';

export interface PipelineRequest {
  text: string;
  tool?: string | null;
  params?: Record<string, unknown>;
}

export type PipelineStage = 'guardrail' | 'tool' | 'complete';

export interface ToolStage {
  execute(toolName: string, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface PipelineStages {
  guardrail?: GuardrailContract | null;
  retrieval?: ((query: string, companyId: CompanyId) => Promise<RetrievalResult[]> | RetrievalResult[]) | null;
  toolExecutor?: ToolStage | null;
  citation?: ((results: RetrievalResult[], companyId: CompanyId) => Promise<Citation[]> | Citation[]) | null;
}

export interface PipelineResult {
  /** True when nothing blocked or refused, and any requested tool succeeded. */
  ok: boolean;
  blocked: boolean;
  reason: string | null;
  retrieval: RetrievalResult[];
  tool_result: ToolResult | null;
  citations: Citation[];
  stage: PipelineStage;
}

export async function runPipeline(input: {
  companyId: CompanyId;
  request: PipelineRequest;
  /** Caller context for the tool stage: userId, user, dryRun. The companyId comes from `companyId` above. */
  context?: Omit<ToolContext, 'companyId'>;
  stages: PipelineStages;
}): Promise<PipelineResult> {
  const companyId = requireCompanyId(input.companyId);
  const request = input.request ?? { text: '' };
  const text = typeof request.text === 'string' ? request.text : '';
  const tool = request.tool ?? null;
  const params = request.params ?? {};
  const stages = input.stages ?? {};

  // 1. Guardrail
  if (stages.guardrail) {
    const verdict = await evaluateGuardrail(stages.guardrail, {
      companyId,
      text,
      tool,
      params,
      context: { stage: 'input' },
    });
    if (!verdict.pass) {
      return { ok: false, blocked: true, reason: verdict.reason, retrieval: [], tool_result: null, citations: [], stage: 'guardrail' };
    }
  }

  // 2. Retrieval
  let retrieval: RetrievalResult[] = [];
  if (stages.retrieval && text !== '') {
    retrieval = await stages.retrieval(text, companyId);
  }

  // 3. Tool
  let toolResult: ToolResult | null = null;
  if (tool !== null) {
    if (!stages.toolExecutor) {
      return { ok: false, blocked: false, reason: 'tool_not_configured', retrieval, tool_result: null, citations: [], stage: 'tool' };
    }
    toolResult = await stages.toolExecutor.execute(tool, params, { ...(input.context ?? {}), companyId });
  }

  // 4. Citation
  let citations: Citation[] = [];
  if (stages.citation && retrieval.length > 0) {
    citations = await stages.citation(retrieval, companyId);
  }

  return {
    ok: toolResult === null || toolResult.ok,
    blocked: false,
    reason: null,
    retrieval,
    tool_result: toolResult,
    citations,
    stage: 'complete',
  };
}
