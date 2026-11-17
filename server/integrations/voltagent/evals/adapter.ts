/**
 * Adapter from the existing ai-runtime evaluator to a VoltAgent-style scorer result.
 *
 * The evaluator lives at server/services/ai-runtime/evaluator.ts and is the source of
 * truth for the scoring rules. This adapter adds no scoring logic of its own.
 * The VoltAgent scorer result shape used below is written from documentation and is
 * NOT verified against the @voltagent/scorers source, which is not in the repo.
 *
 * When evals are disabled (VOLTAGENT_EVALS_ENABLED is not "true") the adapter does
 * nothing and returns a skipped result without calling the evaluator.
 */
import {
  evaluateResponse,
  type EvaluationExpectation,
  type EvaluationInput,
  type EvaluationScore,
  type EvaluationSink,
} from '../../../services/ai-runtime/evaluator.ts';

export interface ScorerResult {
  /** 0 to 1, from the composite 0 to 100 score. */
  score: number;
  metadata: {
    task_completion_rate: number;
    tool_accuracy: number;
    hallucination_flag: 0 | 1;
    response_latency_ms: number;
    agent_name: string;
    session_id: string;
  };
}

export type EvalAdapterResult =
  | { skipped: true; reason: 'evals_disabled' }
  | { skipped: false; score: EvaluationScore; result: ScorerResult };

export interface EvalAdapterOptions {
  enabled: boolean;
  sink?: EvaluationSink;
}

export interface EvalAdapter {
  readonly enabled: boolean;
  evaluate(input: EvaluationInput): Promise<EvalAdapterResult>;
}

/** Maps an evaluator score to the scorer result shape. Pure. */
export function toScorerResult(score: EvaluationScore): ScorerResult {
  return {
    score: Math.round((score.composite_score / 100) * 10000) / 10000,
    metadata: {
      task_completion_rate: score.task_completion_rate,
      tool_accuracy: score.tool_accuracy,
      hallucination_flag: score.hallucination_flag,
      response_latency_ms: score.response_latency_ms,
      agent_name: score.agent_name,
      session_id: score.session_id,
    },
  };
}

export function createEvalAdapter(options: EvalAdapterOptions): EvalAdapter {
  const enabled = options.enabled === true;
  return {
    enabled,
    async evaluate(input: EvaluationInput): Promise<EvalAdapterResult> {
      if (!enabled) return { skipped: true, reason: 'evals_disabled' };
      const score = await evaluateResponse(input, options.sink);
      return { skipped: false, score, result: toScorerResult(score) };
    },
  };
}

export type { EvaluationExpectation, EvaluationInput, EvaluationScore };
