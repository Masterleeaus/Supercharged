import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Users, TrendingUp, TrendingDown, Minus, Zap, BarChart3 } from "lucide-react";
import type { TFunction } from "i18next";
import type { LucideProps } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { Dispatch, SetStateAction, ForwardRefExoticComponent, RefAttributes } from "react";
import { Lead, CRMAnalytics, LeadStage, AI_CATEGORIES, AICategory, AIKanbanResponse, CrmCategoryPreferences, ListViewCard } from "@/pages/crm/shared";
import { AIKanbanColumn } from "@/pages/crm/AIKanbanColumn";

export interface CRMMainContentProps {
  isLoading: boolean;
  viewMode: "kanban" | "list" | "analytics";
  analyticsLoading: boolean;
  analytics: CRMAnalytics;
  t: TFunction<"translation", undefined>;
  aiKanbanLoading: boolean;
  preferencesLoading: boolean;
  aiKanbanData: AIKanbanResponse;
  orderedCategories: ({ color: string; id: "appointment_booked"; label: "Appointment Booked"; icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>; } | { color: string; id: "form_submitted"; label: "Form Submitted"; icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>; } | { color: string; id: "call_transfer"; label: "Call Transfer"; icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>; } | { color: string; id: "need_follow_up"; label: "Need Follow Up"; icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>; } | { color: string; id: "hot"; label: "Hot Lead"; icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>; } | { color: string; id: "warm"; label: "Warm Lead"; icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>; })[];
  aiCategoryFilter: "appointment_booked" | "form_submitted" | "call_transfer" | "need_follow_up" | "hot" | "warm" | "all";
  categoryPreferences: CrmCategoryPreferences;
  searchQuery: string;
  tagFilter: string;
  setSelectedLead: Dispatch<SetStateAction<Lead>>;
  selectedLeadIds: Set<string>;
  toggleLeadSelection: (leadId: string) => void;
  updateColumnSortMutation: UseMutationResult<Response, any, { categoryId: string; sortBy: "newest" | "oldest" | "score-high" | "score-low"; }, unknown>;
  updateCategoryColorMutation: UseMutationResult<Response, any, { categoryId: string; color: string; }, { previousPrefs: CrmCategoryPreferences; }>;
  handleLeadDrop: (leadId: string, targetCategory: AICategory) => void;
  draggingColumnId: string;
  dragOverColumnId: string;
  handleColumnDragStart: (e: React.DragEvent, categoryId: string) => void;
  handleColumnDragOver: (e: React.DragEvent, categoryId: string) => void;
  handleColumnDragLeave: () => void;
  handleColumnDrop: (e: React.DragEvent, targetCategoryId: string) => void;
  handleColumnDragEnd: () => void;
  paginatedLeads: Lead[];
  stages: LeadStage[];
  filteredLeads: Lead[];
  totalPages: number;
  listPage: number;
  LEADS_PER_PAGE: 50;
  setListPage: Dispatch<SetStateAction<number>>;
}

export function CRMMainContent({ isLoading, viewMode, analyticsLoading, analytics, t, aiKanbanLoading, preferencesLoading, aiKanbanData, orderedCategories, aiCategoryFilter, categoryPreferences, searchQuery, tagFilter, setSelectedLead, selectedLeadIds, toggleLeadSelection, updateColumnSortMutation, updateCategoryColorMutation, handleLeadDrop, draggingColumnId, dragOverColumnId, handleColumnDragStart, handleColumnDragOver, handleColumnDragLeave, handleColumnDrop, handleColumnDragEnd, paginatedLeads, stages, filteredLeads, totalPages, listPage, LEADS_PER_PAGE, setListPage }: CRMMainContentProps) {
  return (
    <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : viewMode === "analytics" ? (
          <ScrollArea className="h-full">
            <div className="p-6 space-y-6" data-testid="analytics-view">
              {analyticsLoading ? (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              ) : analytics ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <Card>
                      <CardContent className="p-4">
                        <p className="text-sm text-muted-foreground">{t("crmPage.totalLeads")}</p>
                        <p className="text-2xl font-bold" data-testid="analytics-total-leads">{analytics.totalLeads}</p>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="p-4">
                        <p className="text-sm text-muted-foreground">{t("crmPage.avgLeadScore")}</p>
                        <p className="text-2xl font-bold" data-testid="analytics-avg-score">{analytics.avgLeadScore?.toFixed(1) || '--'}</p>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="p-4">
                        <p className="text-sm text-muted-foreground">{t("crmPage.fromCampaigns")}</p>
                        <p className="text-2xl font-bold" data-testid="analytics-campaign-leads">
                          {analytics.leadsBySource?.find(s => s.sourceType === 'campaign')?.count || 0}
                        </p>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="p-4">
                        <p className="text-sm text-muted-foreground">{t("crmPage.fromIncoming")}</p>
                        <p className="text-2xl font-bold" data-testid="analytics-incoming-leads">
                          {analytics.leadsBySource?.find(s => s.sourceType === 'incoming')?.count || 0}
                        </p>
                      </CardContent>
                    </Card>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">{t("crmPage.leadsByCategory")}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3">
                          {analytics.leadsByCategory?.map((item, index) => {
                            const cat = AI_CATEGORIES.find(c => c.id === item.category);
                            const Icon = cat?.icon;
                            return (
                              <div key={index} className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  {Icon && <Icon className="w-4 h-4" style={{ color: cat?.color }} />}
                                  <span className="text-sm">{cat ? t(`crmPage.categories.${cat.id}`, { defaultValue: cat.label }) : item.category}</span>
                                </div>
                                <Badge variant="secondary">{item.count}</Badge>
                              </div>
                            );
                          }) || <p className="text-sm text-muted-foreground">{t("crmPage.noData")}</p>}
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">{t("crmPage.sentimentBreakdown")}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3">
                          {analytics.sentimentBreakdown?.map((item, index) => (
                            <div key={index} className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                {item.sentiment === 'positive' && <TrendingUp className="w-4 h-4 text-emerald-500" />}
                                {item.sentiment === 'negative' && <TrendingDown className="w-4 h-4 text-rose-500" />}
                                {item.sentiment === 'neutral' && <Minus className="w-4 h-4 text-muted-foreground" />}
                                <span className="text-sm capitalize">{item.sentiment ? t(`sentiment.${item.sentiment}`, { defaultValue: item.sentiment }) : t("crmPage.unknown")}</span>
                              </div>
                              <Badge variant="secondary">{item.count}</Badge>
                            </div>
                          )) || <p className="text-sm text-muted-foreground">{t("crmPage.noData")}</p>}
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-20">
                  <BarChart3 className="w-12 h-12 text-muted-foreground mb-4" />
                  <p className="text-muted-foreground">{t("crmPage.analyticsNotAvailable")}</p>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : viewMode === "kanban" ? (
          <div className="flex gap-4 p-6 overflow-x-auto h-full">
            {aiKanbanLoading || preferencesLoading ? (
              <div className="flex items-center justify-center w-full py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
              </div>
            ) : aiKanbanData ? (
              <>
                {orderedCategories.map((cat) => {
                  const columnData = aiKanbanData.columns?.[cat.id];
                  const isHighlighted = aiCategoryFilter === "all" || aiCategoryFilter === cat.id;
                  const columnSort = categoryPreferences?.columnSortPreferences?.[cat.id];
                  
                  // Apply client-side filtering for search and tags
                  let columnLeads = [...(columnData?.leads || [])];
                  
                  // Filter by search query
                  if (searchQuery) {
                    const query = searchQuery.toLowerCase();
                    columnLeads = columnLeads.filter(lead => {
                      const phone = lead.phone?.toLowerCase() || '';
                      const firstName = lead.firstName?.toLowerCase() || '';
                      const lastName = lead.lastName?.toLowerCase() || '';
                      const email = lead.email?.toLowerCase() || '';
                      return phone.includes(query) ||
                        firstName.includes(query) ||
                        lastName.includes(query) ||
                        email.includes(query) ||
                        (lead.tags?.some(tag => tag.toLowerCase().includes(query)) ?? false);
                    });
                  }
                  
                  // Filter by tag
                  if (tagFilter !== "all") {
                    columnLeads = columnLeads.filter(lead => lead.tags?.includes(tagFilter));
                  }
                  
                  // Apply client-side sorting based on saved preference
                  switch (columnSort) {
                    case 'oldest':
                      columnLeads.sort((a, b) => new Date(a.lastCallAt || a.updatedAt || a.createdAt).getTime() - new Date(b.lastCallAt || b.updatedAt || b.createdAt).getTime());
                      break;
                    case 'score-high':
                      columnLeads.sort((a, b) => (b.leadScore || 0) - (a.leadScore || 0));
                      break;
                    case 'score-low':
                      columnLeads.sort((a, b) => (a.leadScore || 0) - (b.leadScore || 0));
                      break;
                    case 'newest':
                    default:
                      columnLeads.sort((a, b) => new Date(b.lastCallAt || b.updatedAt || b.createdAt).getTime() - new Date(a.lastCallAt || a.updatedAt || a.createdAt).getTime());
                      break;
                  }
                  
                  return (
                    <AIKanbanColumn
                      key={cat.id}
                      category={{ id: cat.id, label: cat.label, color: cat.color }}
                      leads={columnLeads}
                      total={columnData?.total || 0}
                      onLeadClick={setSelectedLead}
                      selectedLeadIds={selectedLeadIds}
                      onToggleSelect={toggleLeadSelection}
                      highlighted={isHighlighted}
                      sortBy={columnSort}
                      onSortChange={(sortBy) => updateColumnSortMutation.mutate({ categoryId: cat.id, sortBy })}
                      onColorChange={(color) => updateCategoryColorMutation.mutate({ categoryId: cat.id, color })}
                      onLeadDrop={handleLeadDrop}
                      isDragging={draggingColumnId === cat.id}
                      isDragOver={dragOverColumnId === cat.id}
                      onDragStart={(e) => handleColumnDragStart(e, cat.id)}
                      onDragOver={(e) => handleColumnDragOver(e, cat.id)}
                      onDragLeave={handleColumnDragLeave}
                      onDrop={(e) => handleColumnDrop(e, cat.id)}
                      onDragEnd={handleColumnDragEnd}
                    />
                  );
                })}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center w-full py-20">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
                  <Zap className="w-8 h-8 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-medium mb-2">No Qualified Leads</h3>
                <p className="text-muted-foreground text-center max-w-md">
                  Leads will appear here when they're categorized by AI during calls.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col h-full">
            <ScrollArea className="flex-1">
              <div className="p-6 space-y-3">
                {paginatedLeads.map(lead => {
                  const leadStage = stages.find(s => s.id === lead.stageId);
                  return (
                    <ListViewCard 
                      key={lead.id} 
                      lead={lead} 
                      onClick={() => setSelectedLead(lead)} 
                      stageColor={leadStage?.color}
                      isSelected={selectedLeadIds.has(lead.id)}
                      onToggleSelect={toggleLeadSelection}
                    />
                  );
                })}
                {filteredLeads.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-20">
                    <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
                      <Users className="w-8 h-8 text-muted-foreground" />
                    </div>
                    <h3 className="text-lg font-medium mb-2">No Leads Found</h3>
                    <p className="text-muted-foreground text-center max-w-md">
                      {searchQuery ? "Try adjusting your search criteria." : "Leads will appear here as campaigns run or calls come in."}
                    </p>
                  </div>
                )}
              </div>
            </ScrollArea>
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-6 py-3 border-t bg-card" data-testid="pagination-controls">
                <span className="text-sm text-muted-foreground">
                  Showing {(listPage - 1) * LEADS_PER_PAGE + 1}-{Math.min(listPage * LEADS_PER_PAGE, filteredLeads.length)} of {filteredLeads.length} leads
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setListPage(p => Math.max(1, p - 1))}
                    disabled={listPage === 1}
                    data-testid="pagination-prev"
                  >
                    Previous
                  </Button>
                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageNum;
                      if (totalPages <= 5) {
                        pageNum = i + 1;
                      } else if (listPage <= 3) {
                        pageNum = i + 1;
                      } else if (listPage >= totalPages - 2) {
                        pageNum = totalPages - 4 + i;
                      } else {
                        pageNum = listPage - 2 + i;
                      }
                      return (
                        <Button
                          key={pageNum}
                          variant={listPage === pageNum ? "secondary" : "ghost"}
                          size="sm"
                          className="w-8 h-8 p-0"
                          onClick={() => setListPage(pageNum)}
                          data-testid={`pagination-page-${pageNum}`}
                        >
                          {pageNum}
                        </Button>
                      );
                    })}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setListPage(p => Math.min(totalPages, p + 1))}
                    disabled={listPage === totalPages}
                    data-testid="pagination-next"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
  );
}
