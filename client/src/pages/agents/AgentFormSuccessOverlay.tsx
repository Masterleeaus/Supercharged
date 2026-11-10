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
import { CheckCircle2 } from "lucide-react";
import type { TFunction } from "i18next";
import { Agent } from "@/pages/agents/shared";

export interface AgentFormSuccessOverlayProps {
  editingAgent: Agent;
  t: TFunction<"translation", undefined>;
}

export function AgentFormSuccessOverlay({ editingAgent, t }: AgentFormSuccessOverlayProps) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/90 backdrop-blur-sm">
                  <div className="flex flex-col items-center gap-4 animate-in zoom-in-50 fade-in duration-300">
                    <div className="h-20 w-20 rounded-full bg-gradient-to-br from-emerald-400 to-green-500 flex items-center justify-center shadow-lg shadow-emerald-500/30">
                      <CheckCircle2 className="h-10 w-10 text-white animate-in zoom-in-75 duration-300 delay-150" />
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-semibold text-foreground">
                        {editingAgent ? t('agents.create.agentUpdated') : t('agents.create.agentCreated')}
                      </p>
                      <p className="text-sm text-muted-foreground">{t('agents.create.readyToUse')}</p>
                    </div>
                  </div>
                </div>
  );
}
