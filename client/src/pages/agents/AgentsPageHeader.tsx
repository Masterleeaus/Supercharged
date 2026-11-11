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
import { Button } from "@/components/ui/button";
import { Plus, Bot, Sparkles, GitBranch, Video } from "lucide-react";
import { Wand2 } from "lucide-react";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { Agent } from "@/pages/agents/shared";

export interface AgentsPageHeaderProps {
  t: TFunction<"translation", undefined>;
  isDemoMode: boolean;
  setIsVideoOpen: Dispatch<SetStateAction<boolean>>;
  setWizardOpen: Dispatch<SetStateAction<boolean>>;
  setCreateDialogOpen: Dispatch<SetStateAction<boolean>>;
  createDialogOpen: boolean;
  combinedAgents: Agent[];
  incomingCount: number;
  flowCount: number;
}

export function AgentsPageHeader({ t, isDemoMode, setIsVideoOpen, setWizardOpen, setCreateDialogOpen, createDialogOpen, combinedAgents, incomingCount, flowCount }: AgentsPageHeaderProps) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-blue-50 via-indigo-50 to-violet-50 dark:from-blue-950/40 dark:via-indigo-950/40 dark:to-violet-950/40 border border-blue-100 dark:border-blue-900/50 p-6 md:p-8">
            <div className="absolute inset-0 bg-grid-slate-200/50 dark:bg-grid-slate-700/20 [mask-image:linear-gradient(0deg,transparent,rgba(255,255,255,0.5))]" />
            <div className="relative flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
                  <Bot className="h-7 w-7 text-white" />
                </div>
                <div>
                  <h1 className="text-2xl md:text-3xl font-bold text-foreground">{t('agents.title')}</h1>
                  <p className="text-muted-foreground mt-0.5">{t('agents.description')}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isDemoMode && (
                  <Button
                    variant="outline"
                    onClick={() => setIsVideoOpen(true)}
                    className="bg-white/80 dark:bg-white/10 hover:bg-white text-blue-900 dark:text-blue-100 border-blue-200 dark:border-blue-800 font-semibold shadow"
                    data-testid="button-watch-demo-agents"
                  >
                    <Video className="h-4 w-4 mr-2 text-blue-600 dark:text-blue-400" />
                    <span>Watch Demo Video</span>
                  </Button>
                )}
                <Button
                  onClick={() => setWizardOpen(true)}
                  variant="outline"
                  className="border-violet-200 dark:border-violet-800 hover:bg-violet-50 dark:hover:bg-violet-950"
                  data-testid="button-wizard-agent"
                >
                  <Wand2 className="h-4 w-4 mr-2 text-violet-600 dark:text-violet-400" />
                  {t('agents.guidedWizard', 'Guided Wizard')}
                </Button>
                <Button
                  onClick={() => setCreateDialogOpen(true)}
                  disabled={createDialogOpen}
                  className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg"
                  data-testid="button-create-agent"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  {t('agents.createNew')}
                </Button>
              </div>
            </div>

            {/* Stats Row */}
            <div className="relative mt-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Total Agents */}
              <div className="bg-white/70 dark:bg-zinc-900/60 backdrop-blur-md rounded-xl p-6 border border-blue-100/60 dark:border-blue-900/30 hover-elevate transition-all shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-blue-600/70 dark:text-blue-400/70 text-xs font-semibold uppercase tracking-wider">{t('agents.stats.totalAgents')}</span>
                  <div className="h-8 w-8 rounded-lg bg-blue-100 dark:bg-blue-950/40 flex items-center justify-center text-blue-600 dark:text-blue-400">
                    <Bot className="h-4 w-4" />
                  </div>
                </div>
                <div className="text-3xl font-extrabold text-blue-700 dark:text-blue-300 mb-2">{combinedAgents.length}</div>
                <div className="w-full bg-blue-100/50 dark:bg-blue-950/20 h-1.5 rounded-full overflow-hidden">
                  <div className="bg-gradient-to-r from-blue-500 to-indigo-500 h-full rounded-full" style={{ width: '100%' }} />
                </div>
              </div>

              {/* Incoming Agents */}
              <div className="bg-white/70 dark:bg-zinc-900/60 backdrop-blur-md rounded-xl p-6 border border-emerald-100/60 dark:border-emerald-900/30 hover-elevate transition-all shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-emerald-600/70 dark:text-emerald-400/70 text-xs font-semibold uppercase tracking-wider">{t('agents.type.incoming')}</span>
                  <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                    <Sparkles className="h-4 w-4" />
                  </div>
                </div>
                <div className="text-3xl font-extrabold text-emerald-700 dark:text-emerald-300 mb-2">{incomingCount}</div>
                <div className="w-full bg-emerald-100/50 dark:bg-emerald-950/25 h-1.5 rounded-full overflow-hidden">
                  <div 
                    className="bg-emerald-500 h-full rounded-full transition-all duration-500" 
                    style={{ width: `${combinedAgents.length > 0 ? (incomingCount / combinedAgents.length) * 100 : 0}%` }} 
                  />
                </div>
              </div>

              {/* Flow Agents */}
              <div className="bg-white/70 dark:bg-zinc-900/60 backdrop-blur-md rounded-xl p-6 border border-violet-100/60 dark:border-violet-900/30 hover-elevate transition-all shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-violet-600/70 dark:text-violet-400/70 text-xs font-semibold uppercase tracking-wider">{t('agents.type.flow')}</span>
                  <div className="h-8 w-8 rounded-lg bg-violet-100 dark:bg-violet-950/40 flex items-center justify-center text-violet-600 dark:text-violet-400">
                    <GitBranch className="h-4 w-4" />
                  </div>
                </div>
                <div className="text-3xl font-extrabold text-violet-700 dark:text-violet-300 mb-2">{flowCount}</div>
                <div className="w-full bg-violet-100/50 dark:bg-violet-950/25 h-1.5 rounded-full overflow-hidden">
                  <div 
                    className="bg-violet-500 h-full rounded-full transition-all duration-500" 
                    style={{ width: `${combinedAgents.length > 0 ? (flowCount / combinedAgents.length) * 100 : 0}%` }} 
                  />
                </div>
              </div>
            </div>
          </div>
  );
}
