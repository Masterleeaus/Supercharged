/**
 * VoltAgent feature flags.
 *
 * Every flag is OFF unless its environment variable is exactly "true".
 * Nothing reads these flags yet, and no routes are mounted from them in Phase 0.
 */
function readFlag(name: string, env: NodeJS.ProcessEnv): boolean {
  return env[name] === 'true';
}

export function readVoltAgentFlags(env: NodeJS.ProcessEnv = process.env) {
  return Object.freeze({
    agentsEnabled: readFlag('VOLTAGENT_AGENTS_ENABLED', env),
    workflowsEnabled: readFlag('VOLTAGENT_WORKFLOWS_ENABLED', env),
    ragEnabled: readFlag('VOLTAGENT_RAG_ENABLED', env),
    pgvectorEnabled: readFlag('VOLTAGENT_PGVECTOR_ENABLED', env),
    rerankEnabled: readFlag('VOLTAGENT_RERANK_ENABLED', env),
    telemetryEnabled: readFlag('VOLTAGENT_TELEMETRY_ENABLED', env),
    evalsEnabled: readFlag('VOLTAGENT_EVALS_ENABLED', env),
    mcpEnabled: readFlag('VOLTAGENT_MCP_ENABLED', env),
    voiceEnabled: readFlag('VOLTAGENT_VOICE_ENABLED', env),
  } as const);
}

export const voltAgentFlags = Object.freeze(readVoltAgentFlags());
