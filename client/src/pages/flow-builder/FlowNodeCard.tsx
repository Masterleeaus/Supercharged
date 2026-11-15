/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */

import { Handle, Position, type NodeTypes } from "@xyflow/react";

import { Input } from "@/components/ui/input";

import { MessageSquare } from "lucide-react";

import { nodeTypeIcons, nodeTypeColors } from "./types";

// Custom node component with connection handles
function FlowNode({ data, selected }: { data: any; selected?: boolean }) {
  const Icon = nodeTypeIcons[data.type as keyof typeof nodeTypeIcons] || MessageSquare;
  const colors = nodeTypeColors[data.type as keyof typeof nodeTypeColors] || nodeTypeColors.message;
  const hasMultipleOutputs = data.type === "condition";

  return (
    <div className="relative">
      {/* Input Handle (top) */}
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: colors.handle }}
        className="!w-3 !h-3 !border-2 !border-white dark:!border-gray-900"
      />

      <div className={`bg-gradient-to-br ${colors.bg} rounded-lg p-3 min-w-[220px] shadow-lg ${selected ? 'ring-2 ring-white dark:ring-gray-300 ring-offset-2 ring-offset-background' : ''} transition-all hover:shadow-xl`}>
        <div className="flex items-center gap-2.5">
          <Icon className={`w-5 h-5 ${colors.icon} flex-shrink-0`} />
          <div className="flex-1 min-w-0">
            <div className={`font-semibold text-sm ${colors.text}`}>{data.label}</div>
            {data.config?.message && (
              <div className="text-xs text-white/80 mt-1 truncate">
                {data.config.message.substring(0, 50)}...
              </div>
            )}
            {data.config?.question && (
              <div className="text-xs text-white/80 mt-1 truncate">
                {data.config.question.substring(0, 50)}...
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Output Handle (bottom) - single or multiple */}
      {hasMultipleOutputs ? (
        <>
          <Handle
            type="source"
            position={Position.Bottom}
            id="true"
            style={{ left: '30%', background: '#22c55e' }}
            className="!w-3 !h-3 !border-2 !border-white dark:!border-gray-900"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="false"
            style={{ left: '70%', background: '#ef4444' }}
            className="!w-3 !h-3 !border-2 !border-white dark:!border-gray-900"
          />
        </>
      ) : (
        <Handle
          type="source"
          position={Position.Bottom}
          style={{ background: colors.handle }}
          className="!w-3 !h-3 !border-2 !border-white dark:!border-gray-900"
        />
      )}
    </div>
  );
}

export const nodeTypes: NodeTypes = {
  message: FlowNode,
  question: FlowNode,
  condition: FlowNode,
  appointment: FlowNode,
  form: FlowNode,
  webhook: FlowNode,
  transfer: FlowNode,
  delay: FlowNode,
  end: FlowNode,
  play_audio: FlowNode,
  send_email: FlowNode,
  send_whatsapp: FlowNode,
  custom: FlowNode,
};

