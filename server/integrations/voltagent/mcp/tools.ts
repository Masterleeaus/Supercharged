/**
 * Internal MCP tool registry (W9). Internal-only: nothing here is mounted on a public route.
 *
 * Read-only tools are callable. Write tools exist only as declarations and can run only
 * through the approval gate: the caller must present an approval id that the injected
 * approval check accepts for that tenant and tool. Gate G5 (security review) is still
 * pending, so no write tool is registered by this module.
 *
 * The MCP wire protocol is not implemented here. The VoltAgent @voltagent/mcp-server
 * API is not in the repo and is NOT verified.
 */
import { hashToolParams } from '../../../workforce/runtime/tool-registry.ts';

export type McpToolKind = 'read' | 'write';

export interface McpToolDefinition {
  name: string;
  kind: McpToolKind;
  handler: (params: Record<string, unknown>, companyId: string) => unknown | Promise<unknown>;
}

export interface McpCallRequest {
  companyId: string;
  tool: string;
  params?: Record<string, unknown>;
  approvalId?: string | null;
}

export type McpCallResult =
  | { ok: true; result: unknown }
  | { ok: false; code: 'company_required' | 'unknown_tool' | 'approval_required' | 'approval_rejected' | 'tool_failed'; message: string };

/** Fixed message for a failed handler. The handler's own error text is never returned to the caller. */
export const TOOL_FAILED_MESSAGE = 'tool failed';

export interface McpRegistryOptions {
  enabled: boolean;
  tools?: McpToolDefinition[];
  /**
   * Returns true only when the approval id is valid for this tenant, this tool and this exact params
   * hash (paramsSha256, from hashToolParams). The checker must also refuse an approval that has already
   * been used, so one approval covers one call. Required for write tools; absent means refuse.
   */
  checkApproval?: (
    approvalId: string,
    companyId: string,
    tool: string,
    paramsSha256: string,
  ) => boolean | Promise<boolean>;
}

export interface McpRegistry {
  readonly enabled: boolean;
  list(): Array<{ name: string; kind: McpToolKind }>;
  call(request: McpCallRequest): Promise<McpCallResult>;
}

export function createMcpRegistry(options: McpRegistryOptions): McpRegistry {
  const enabled = options.enabled === true;
  const tools = new Map<string, McpToolDefinition>();
  for (const tool of options.tools ?? []) {
    if (tools.has(tool.name)) throw new Error(`duplicate MCP tool: ${tool.name}`);
    tools.set(tool.name, tool);
  }

  return {
    enabled,
    list() {
      if (!enabled) return [];
      return [...tools.values()].map(({ name, kind }) => ({ name, kind }));
    },
    async call(request: McpCallRequest): Promise<McpCallResult> {
      if (!enabled) return { ok: false, code: 'unknown_tool', message: 'MCP is disabled' };
      if (typeof request.companyId !== 'string' || request.companyId.trim() === '') {
        return { ok: false, code: 'company_required', message: 'companyId is required' };
      }
      const tool = tools.get(request.tool);
      if (!tool) return { ok: false, code: 'unknown_tool', message: `unknown tool: ${request.tool}` };

      if (tool.kind === 'write') {
        if (!request.approvalId) {
          return { ok: false, code: 'approval_required', message: 'write tools need an approval id' };
        }
        let approved: unknown = false;
        if (options.checkApproval) {
          let paramsSha256: string;
          try {
            paramsSha256 = hashToolParams(request.params ?? {});
          } catch {
            // Params that cannot be serialised cannot be bound to an approval, so they are refused.
            return { ok: false, code: 'approval_rejected', message: 'approval was not accepted for this tenant and tool' };
          }
          approved = await options.checkApproval(request.approvalId, request.companyId, tool.name, paramsSha256);
        }
        if (approved !== true) {
          return { ok: false, code: 'approval_rejected', message: 'approval was not accepted for this tenant and tool' };
        }
      }

      try {
        const result = await tool.handler(request.params ?? {}, request.companyId);
        return { ok: true, result };
      } catch {
        return { ok: false, code: 'tool_failed', message: TOOL_FAILED_MESSAGE };
      }
    },
  };
}
