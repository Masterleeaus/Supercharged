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
import { Input } from "@/components/ui/input";
import { Search, Bot, Sparkles, GitBranch } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { Agent } from "@/pages/agents/shared";

export interface AgentsFilterBarProps {
  typeFilter: "incoming" | "flow" | "all" | "cve";
  setTypeFilter: Dispatch<SetStateAction<"incoming" | "flow" | "all" | "cve">>;
  t: TFunction<"translation", undefined>;
  agents: Agent[];
  incomingCount: number;
  flowCount: number;
  isCustomVoiceEngineEnabled: boolean;
  cveCount: number;
  hasAlternateEngines: boolean;
  engineFilter: "twilio" | "plivo" | "twilio_openai" | "elevenlabs-sip" | "openai-sip" | "all";
  setEngineFilter: Dispatch<SetStateAction<"twilio" | "plivo" | "twilio_openai" | "elevenlabs-sip" | "openai-sip" | "all">>;
  isTwilioOpenaiEnabled: boolean;
  isPlivoEnabled: boolean;
  isElevenLabsSipAllowed: boolean;
  isOpenAISipAllowed: boolean;
  searchQuery: string;
  setSearchQuery: Dispatch<SetStateAction<string>>;
}

export function AgentsFilterBar({ typeFilter, setTypeFilter, t, agents, incomingCount, flowCount, isCustomVoiceEngineEnabled, cveCount, hasAlternateEngines, engineFilter, setEngineFilter, isTwilioOpenaiEnabled, isPlivoEnabled, isElevenLabsSipAllowed, isOpenAISipAllowed, searchQuery, setSearchQuery }: AgentsFilterBarProps) {
  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            {/* Type Filter Tabs */}
            <div className="flex items-center gap-2 p-1 bg-muted/50 rounded-lg">
              <Button
                variant={typeFilter === 'all' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setTypeFilter('all')}
                className={typeFilter === 'all' ? '' : 'text-muted-foreground'}
                data-testid="button-filter-all"
              >
                {t('common.all')} ({agents.length})
              </Button>
              <Button
                variant={typeFilter === 'incoming' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setTypeFilter('incoming')}
                className={typeFilter === 'incoming' ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'text-muted-foreground hover:text-emerald-600'}
                data-testid="button-filter-incoming"
              >
                <Sparkles className="h-4 w-4 mr-1.5" />
                {t('agents.type.incoming')} ({incomingCount})
              </Button>
              <Button
                variant={typeFilter === 'flow' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setTypeFilter('flow')}
                className={typeFilter === 'flow' ? 'bg-violet-600 hover:bg-violet-700 text-white' : 'text-muted-foreground hover:text-violet-600'}
                data-testid="button-filter-flow"
              >
                <GitBranch className="h-4 w-4 mr-1.5" />
                {t('agents.type.flow')} ({flowCount})
              </Button>
              {isCustomVoiceEngineEnabled && (
                <Button
                  variant={typeFilter === 'cve' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setTypeFilter('cve')}
                  className={typeFilter === 'cve' ? 'bg-orange-600 hover:bg-orange-700 text-white' : 'text-muted-foreground hover:text-orange-600'}
                  data-testid="button-filter-cve"
                >
                  <Bot className="h-4 w-4 mr-1.5" />
                  Custom Voice ({cveCount})
                </Button>
              )}
            </div>

            {/* Engine Filter Dropdown - Show if multiple engines exist */}
            {hasAlternateEngines && (
              <Select
                value={engineFilter}
                onValueChange={(value) => setEngineFilter(value as typeof engineFilter)}
              >
                <SelectTrigger className="w-48" data-testid="select-engine-filter">
                  <SelectValue placeholder="Filter by engine" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Engines</SelectItem>
                  <SelectItem value="twilio">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-violet-500" />
                      ElevenLabs + Twilio
                    </div>
                  </SelectItem>
                  {isTwilioOpenaiEnabled && (
                    <SelectItem value="twilio_openai">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-brand" />
                        OpenAI + Twilio
                      </div>
                    </SelectItem>
                  )}
                  {isPlivoEnabled && (
                    <SelectItem value="plivo">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-emerald-500" />
                        OpenAI + Plivo
                      </div>
                    </SelectItem>
                  )}
                  {isElevenLabsSipAllowed && (
                    <SelectItem value="elevenlabs-sip">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-orange-500" />
                        ElevenLabs SIP
                      </div>
                    </SelectItem>
                  )}
                  {isOpenAISipAllowed && (
                    <SelectItem value="openai-sip">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-pink-500" />
                        OpenAI SIP
                      </div>
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            )}

            {/* Search */}
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('agents.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
                data-testid="input-search-agents"
              />
            </div>
          </div>
  );
}
