# AI Models & Fallback Behavior

This document explains how AI models are configured, registered, and managed in the product, how fallback mechanics handle unrecognized or deprecated models, how buyers can audit the models in use, and compatibility limitations.

---

## 1. Where Supported Models Are Configured or Registered

Supported models are defined and managed across several layers in the application:

1. **Database Seed Data**: 
   Standard chat/LLM models are registered in the `llm_models` table. The initial list is seeded from [server/seed-llm-models-data.ts](file:///c:/nodejs_backend/agentlab_v2/agentlabs/server/seed-llm-models-data.ts) (variable `MODELS_SEED_DATA`).
2. **Provider-Specific Configurations**:
   For the custom voice engines (Twilio/Plivo utilizing OpenAI Realtime), supported models are mapped in the codebase to handle licensing, plan restrictions, and streaming interfaces:
   - **Twilio Engine**: Configured in [server/engines/twilio-openai/types.ts](file:///c:/nodejs_backend/agentlab_v2/agentlabs/server/engines/twilio-openai/types.ts) within the `MODEL_TIER_CONFIG` mapping.
   - **Plivo Engine**: Configured in [server/engines/plivo/types.ts](file:///c:/nodejs_backend/agentlab_v2/agentlabs/server/engines/plivo/types.ts) within the `MODEL_TIER_CONFIG` mapping.

---

## 2. How Compatible Models Can Be Added or Updated

To add or update compatible models:

### Adding to the Allowed Realtime Models List
1. Locate the engine configuration files:
   - For Twilio: [server/engines/twilio-openai/types.ts](file:///c:/nodejs_backend/agentlab_v2/agentlabs/server/engines/twilio-openai/types.ts)
   - For Plivo: [server/engines/plivo/types.ts](file:///c:/nodejs_backend/agentlab_v2/agentlabs/server/engines/plivo/types.ts)
2. Add the new model ID (e.g. `'gpt-realtime-next'`) to the `OpenAIRealtimeModel` union type.
3. Update the `MODEL_TIER_CONFIG` for `free` and/or `pro` tiers to include the new model in their `models` array.

### Adding to the Database/ElevenLabs List
1. Edit [server/seed-llm-models-data.ts](file:///c:/nodejs_backend/agentlab_v2/agentlabs/server/seed-llm-models-data.ts) to append the new model configuration (defining its `modelId`, `name`, `tier`, etc.).
2. Run the database seed script to insert or update the model configurations in the database.

---

## 3. How Fallback Behavior Works

When an agent is configured with an unavailable, deprecated, or unsupported model:

1. **Validation & Resolution**: During call stream initialization, the `OpenAIAgentFactory.validateModel` method verifies the requested model against the allowed models for the user's plan tier.
2. **Safe Fallback Redirection**: If the requested model is not allowed or is unrecognized, the engine falls back to an explicitly defined `safeFallback` model (currently set to `'gpt-realtime-mini'`).
3. **Database Transparency Updates**:
   - The call record's `openaiModel` column is updated in the database to reflect the actual fallback model being used.
   - The call's `metadata` JSON field is updated to set `modelFallbackApplied: true` and record the `originalModelRequested` so the buyer has a transparent audit trail.
   - A warning is written to the server logs.

---

## 4. How Buyers Can Confirm Which Model Is Being Used

Buyers can audit and verify the active model using the following mechanisms:

1. **Call Records / API Details**:
   - Call endpoints such as `/api/calls/:id` return the call details which map to the `twilio_openai_calls` or `plivo_calls` tables.
   - In the returned JSON payload, check:
     - `openaiModel`: The exact name of the model that was actually executed during the call session.
     - `metadata.modelFallbackApplied`: A boolean flag indicating if a fallback replacement was executed.
     - `metadata.originalModelRequested`: The identifier of the model originally configured by the buyer.
2. **Server Console/Logging**:
   - The application outputs warning messages to standard out when fallback execution is triggered:
     `[TwilioOpenAI Stream] Fallback model applied for call <callId>: requested "<originalModel>" → using "<fallbackModel>"`

---

## 5. Compatibility Limitations

- **Streaming / Realtime Compatibility**: 
  Standard chat LLMs (e.g. `gpt-4o`, `claude-3-5-sonnet`) do not support low-latency streaming audio websocket APIs directly. Therefore, the custom voice call workflow (Twilio and Plivo audio streams) requires OpenAI Realtime-compatible models (e.g. `gpt-realtime-mini`, `gpt-realtime-2`).
- **ElevenLabs Compatibility**: 
  ElevenLabs voice call workflows use conversational agents which do not run on the OpenAI Realtime websocket interface. As a result, when synching agents to ElevenLabs, unsupported realtime model identifiers are automatically mapped to standard compatible LLM equivalents (such as mapping `gpt-realtime-mini` to `gpt-4o-mini`) via [server/utils/llm-sanitize.ts](file:///c:/nodejs_backend/agentlab_v2/agentlabs/server/utils/llm-sanitize.ts).
