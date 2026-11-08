/**
 * Agent response evaluator. Ported from TitanPro Modules/TitanZero/Evaluation/AgentEvaluator.php, with the
 * scoring heuristics and weights kept. Persistence (AgentEvaluationScore model) is replaced by an injected sink.
 *
 * Metrics:
 *   task_completion_rate  0-100  60 for a non-empty response, +20 for a result or message key,
 *                                +20 for all expected_keys (pro rata when some are missing)
 *   hallucination_flag    0 or 1 forbidden_strings found in the response, or "as an ai" when a result is present
 *   tool_accuracy         0-100  share of expected_tools that appear in response.tool_calls (recall only)
 *   response_latency_ms   recorded, not part of the composite
 * Composite (0-100) = 0.5 * task + 0.3 * tool + 0.2 * (100 when no hallucination, else 0).
 *
 * Changes from TitanPro (see PORT-MAP.md):
 * - Forbidden strings are matched against response values only. TitanPro's text includes JSON keys, so
 *   "result" as a forbidden string matches every response that has a result key.
 * - An empty forbidden string is skipped. In PHP 8, str_contains($text, '') is true, so TitanPro flags every response.
 * - companyId is required and is passed to the sink, so every saved score belongs to one tenant.
 *
 * Known limitation kept from TitanPro: tool accuracy does not penalise extra or wrong tool calls.
 */
import { requireCompanyId } from './company.ts';
import { AiRuntimeError, type CompanyId } from './types.ts';

export const COMPOSITE_WEIGHTS = { taskCompletion: 0.5, toolAccuracy: 0.3, hallucinationFree: 0.2 } as const;

export interface EvaluationExpectation {
  expected_keys?: string[];
  forbidden_strings?: string[];
  expected_tools?: string[];
}

export interface EvaluationScore {
  company_id: CompanyId;
  agent_name: string;
  session_id: string;
  task_completion_rate: number;
  hallucination_flag: 0 | 1;
  tool_accuracy: number;
  response_latency_ms: number;
  composite_score: number;
  response_snapshot: string;
}

export interface EvaluationInput {
  companyId: CompanyId;
  agentName: string;
  sessionId: string;
  response: Record<string, unknown>;
  expectedOutcome?: EvaluationExpectation;
  latencyMs?: number;
}

export type EvaluationSink = (score: EvaluationScore) => void | Promise<void>;

function isEmptyObject(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 0;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isSet(obj: Record<string, unknown>, key: string): boolean {
  return hasOwn(obj, key) && obj[key] !== null && obj[key] !== undefined;
}

/** Collects every string-like value in the response, depth first, joined with newlines. Keys are excluded. */
function collectValueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(collectValueText).join('\n');
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).map(collectValueText).join('\n');
  return '';
}

export function scoreTaskCompletion(response: Record<string, unknown>, expected: EvaluationExpectation = {}): number {
  if (isEmptyObject(response)) return 0;

  let score = 60;
  if (isSet(response, 'result') || isSet(response, 'message')) score += 20;

  const expectedKeys = expected.expected_keys ?? [];
  if (expectedKeys.length > 0) {
    const present = expectedKeys.filter((key) => hasOwn(response, key)).length;
    score += Math.round(20 * (present / expectedKeys.length));
  } else {
    score += 20;
  }

  return Math.min(100, score);
}

export function detectHallucination(response: Record<string, unknown>, expected: EvaluationExpectation = {}): 0 | 1 {
  const text = collectValueText(response).toLowerCase();

  for (const term of expected.forbidden_strings ?? []) {
    const needle = String(term).toLowerCase();
    if (needle !== '' && text.includes(needle)) return 1;
  }

  if (isSet(response, 'result') && text.includes('as an ai')) return 1;

  return 0;
}

export function scoreToolAccuracy(response: Record<string, unknown>, expected: EvaluationExpectation = {}): number {
  const expectedTools = expected.expected_tools ?? [];
  if (expectedTools.length === 0) return 100;

  const actual = Array.isArray(response.tool_calls) ? (response.tool_calls as unknown[]).map(String) : [];
  const matched = expectedTools.filter((tool) => actual.includes(tool)).length;
  return Math.round(100 * (matched / expectedTools.length));
}

export function compositeScore(taskCompletion: number, hallucinationFlag: 0 | 1 | number, toolAccuracy: number): number {
  const hallucinationFree = hallucinationFlag === 1 ? 0 : 100;
  const value =
    taskCompletion * COMPOSITE_WEIGHTS.taskCompletion +
    toolAccuracy * COMPOSITE_WEIGHTS.toolAccuracy +
    hallucinationFree * COMPOSITE_WEIGHTS.hallucinationFree;
  return Math.round(value * 100) / 100;
}

/** Scores one response for one tenant. Passes the score to the sink when one is given. */
export async function evaluateResponse(input: EvaluationInput, sink?: EvaluationSink): Promise<EvaluationScore> {
  const companyId = requireCompanyId(input?.companyId);
  if (typeof input.agentName !== 'string' || input.agentName.trim() === '') {
    throw new AiRuntimeError('input_invalid', 'agentName is required');
  }
  if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') {
    throw new AiRuntimeError('input_invalid', 'sessionId is required');
  }
  const latency = input.latencyMs ?? 0;
  if (!Number.isFinite(latency) || latency < 0) {
    throw new AiRuntimeError('input_invalid', 'latencyMs must be a non-negative number');
  }

  const expected = input.expectedOutcome ?? {};
  const task = scoreTaskCompletion(input.response, expected);
  const hallucination = detectHallucination(input.response, expected);
  const tool = scoreToolAccuracy(input.response, expected);

  const score: EvaluationScore = {
    company_id: companyId,
    agent_name: input.agentName,
    session_id: input.sessionId,
    task_completion_rate: task,
    hallucination_flag: hallucination,
    tool_accuracy: tool,
    response_latency_ms: Math.round(latency),
    composite_score: compositeScore(task, hallucination, tool),
    response_snapshot: JSON.stringify(input.response),
  };

  if (sink) await sink(score);
  return score;
}
