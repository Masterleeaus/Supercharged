/**
 * Sanitize LLM model ID for ElevenLabs API compatibility
 * Maps unsupported models to supported equivalents.
 */
import { logger } from './logger';
export function sanitizeLlmModel(modelId: string | undefined): string {
  if (!modelId) return 'gpt-4o-mini';

  const UNSUPPORTED_MAPPINGS: Record<string, string> = {
    'gpt-realtime-mini': 'gpt-4o-mini',
    'gpt-4o-mini-realtime-preview': 'gpt-4o-mini',
    'gpt-realtime': 'gpt-4o',
    'gpt-realtime-1.5': 'gpt-4o',
    'gpt-4o-realtime-preview': 'gpt-4o',
  };

  const sanitized = UNSUPPORTED_MAPPINGS[modelId] || modelId;
  if (sanitized !== modelId) {
    logger.info(`🧹 [ElevenLabs] Sanitized unsupported model: ${modelId} -> ${sanitized}`);
  }
  return sanitized;
}
