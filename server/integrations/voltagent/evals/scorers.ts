/**
 * Local scorers for the VoltAgent evals integration (issue #382).
 *
 * Each scorer is a thin, named view over the scoring rules in
 * server/services/ai-runtime/evaluator.ts. They add no scoring logic of their own, so
 * the ai-runtime evaluator stays the single source of truth.
 *
 * Decision (default, no owner input): scorers run locally in-process. No VoltAgent
 * scorer package is installed, because its API is not verified in this repo.
 * Each scorer returns a 0 to 1 score plus metadata.
 */
import {
  compositeScore,
  detectHallucination,
  scoreTaskCompletion,
  scoreToolAccuracy,
  type EvaluationExpectation,
} from '../../../services/ai-runtime/evaluator.ts';

export interface LocalScorerInput {
  response: Record<string, unknown>;
  expectedOutcome?: EvaluationExpectation;
}

export interface LocalScorerResult {
  name: string;
  /** 0 to 1. */
  score: number;
  metadata: Record<string, number | string>;
}

export type LocalScorer = (input: LocalScorerInput) => LocalScorerResult;

/** Share of expected keys present, plus the response-shape bonuses. Scaled to 0 to 1. */
export const taskCompletionScorer: LocalScorer = ({ response, expectedOutcome }) => {
  const raw = scoreTaskCompletion(response, expectedOutcome ?? {});
  return { name: 'task_completion', score: raw / 100, metadata: { task_completion_rate: raw } };
};

/** 1 when no forbidden string appears in response values, 0 when one does. */
export const hallucinationScorer: LocalScorer = ({ response, expectedOutcome }) => {
  const flag = detectHallucination(response, expectedOutcome ?? {});
  return { name: 'hallucination_free', score: flag === 1 ? 0 : 1, metadata: { hallucination_flag: flag } };
};

/** Recall of expected tools in response.tool_calls. Extra tool calls are not penalised (known limitation). */
export const toolAccuracyScorer: LocalScorer = ({ response, expectedOutcome }) => {
  const raw = scoreToolAccuracy(response, expectedOutcome ?? {});
  return { name: 'tool_accuracy', score: raw / 100, metadata: { tool_accuracy: raw } };
};

export const LOCAL_SCORERS: readonly LocalScorer[] = [taskCompletionScorer, hallucinationScorer, toolAccuracyScorer];

/** Runs every local scorer and adds the weighted composite (0 to 1), using the evaluator's weights. */
export function runLocalScorers(input: LocalScorerInput): { results: LocalScorerResult[]; composite: number } {
  const results = LOCAL_SCORERS.map((scorer) => scorer(input));
  const task = Math.round(results[0].score * 100);
  const flag = results[1].score === 0 ? 1 : 0;
  const tool = Math.round(results[2].score * 100);
  return { results, composite: compositeScore(task, flag, tool) / 100 };
}
