import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Search, LayoutGrid, List, RefreshCw, Zap, Tag, BarChart3 } from "lucide-react";
import type { TFunction } from "i18next";
import type { UseMutationResult, QueryClient } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";
import { Campaign, IncomingConnection } from "@/pages/crm/shared";

export interface CRMToolbarProps {
  t: TFunction<"translation", undefined>;
  searchQuery: string;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  sourceFilter: string;
  setSourceFilter: Dispatch<SetStateAction<string>>;
  setSelectedSourceId: Dispatch<SetStateAction<string>>;
  campaigns: Campaign[];
  selectedSourceId: string;
  incomingConnections: IncomingConnection[];
  allTags: string[];
  tagFilter: string;
  setTagFilter: Dispatch<SetStateAction<string>>;
  backfillCategoriesMutation: UseMutationResult<any, any, void, unknown>;
  queryClientRef: QueryClient;
  viewMode: "kanban" | "list" | "analytics";
  setViewMode: Dispatch<SetStateAction<"kanban" | "list" | "analytics">>;
}

export function CRMToolbar({ t, searchQuery, setSearchQuery, sourceFilter, setSourceFilter, setSelectedSourceId, campaigns, selectedSourceId, incomingConnections, allTags, tagFilter, setTagFilter, backfillCategoriesMutation, queryClientRef, viewMode, setViewMode }: CRMToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-4 px-6 py-3 border-b bg-muted/30">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder={t("crmPage.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-background"
            data-testid="search-leads-input"
          />
        </div>
        
        <Select value={sourceFilter} onValueChange={(v) => { setSourceFilter(v); setSelectedSourceId("all"); }}>
          <SelectTrigger className="w-40 bg-background" data-testid="source-filter">
            <SelectValue placeholder={t("crmPage.allSources")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("crmPage.allSources")}</SelectItem>
            <SelectItem value="campaign">{t("crmPage.campaigns")}</SelectItem>
            <SelectItem value="incoming">{t("crmPage.incoming")}</SelectItem>
          </SelectContent>
        </Select>

        {sourceFilter === "campaign" && campaigns.length > 0 && (
          <Select value={selectedSourceId} onValueChange={setSelectedSourceId}>
            <SelectTrigger className="w-52 bg-background" data-testid="campaign-filter">
              <SelectValue placeholder={t("crmPage.allCampaigns")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("crmPage.allCampaigns")}</SelectItem>
              {campaigns.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {sourceFilter === "incoming" && incomingConnections.length > 0 && (
          <Select value={selectedSourceId} onValueChange={setSelectedSourceId}>
            <SelectTrigger className="w-52 bg-background" data-testid="incoming-filter">
              <SelectValue placeholder={t("crmPage.allConnections")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("crmPage.allConnections")}</SelectItem>
              {incomingConnections.map(c => (
                <SelectItem key={c.id} value={c.id}>Connection {c.id.slice(0, 8)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {allTags.length > 0 && (
          <Select value={tagFilter} onValueChange={setTagFilter}>
            <SelectTrigger className="w-40 bg-background" data-testid="tag-filter">
              <Tag className="w-4 h-4 mr-2" />
              <SelectValue placeholder={t("crmPage.allTags")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("crmPage.allTags")}</SelectItem>
              {allTags.map(tag => (
                <SelectItem key={tag} value={tag}>{tag}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={backfillCategoriesMutation.isPending}
                data-testid="refresh-leads"
                title="Refresh Options"
              >
                <RefreshCw className={`w-4 h-4 ${backfillCategoriesMutation.isPending ? 'animate-spin' : ''}`} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem 
                onClick={() => {
                  queryClientRef.invalidateQueries({ predicate: (query) => {
                    const key = query.queryKey[0];
                    if (typeof key !== 'string') return false;
                    return key.startsWith('/api/crm/leads/');
                  }});
                }}
                data-testid="quick-refresh"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                {t("crmPage.quickRefresh")}
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => backfillCategoriesMutation.mutate()}
                data-testid="recategorize-leads"
              >
                <Zap className="w-4 h-4 mr-2" />
                {t("crmPage.recategorizeAll")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          
          <div className="h-6 w-px bg-border mx-1" />
          
          <div className="flex items-center rounded-lg border bg-background p-1 gap-1">
            <Button
              variant={viewMode === "kanban" ? "secondary" : "ghost"}
              size="icon"
              onClick={() => setViewMode("kanban")}
              data-testid="view-kanban"
              title={t("crmPage.kanbanView")}
            >
              <LayoutGrid className="w-4 h-4" />
            </Button>
            <Button
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="icon"
              onClick={() => setViewMode("list")}
              data-testid="view-list"
              title={t("crmPage.listView")}
            >
              <List className="w-4 h-4" />
            </Button>
            <Button
              variant={viewMode === "analytics" ? "secondary" : "ghost"}
              size="icon"
              onClick={() => setViewMode("analytics")}
              data-testid="view-analytics"
              title={t("crmPage.analyticsView")}
            >
              <BarChart3 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
  );
}
