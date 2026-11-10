import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { ArrowRightLeft, Tag, Trash2, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Lead, CRMAnalytics, LeadStage, Campaign, IncomingConnection, AI_CATEGORIES, AICategory, CategoryCounts, PaginatedLeadsResponse, AIKanbanResponse, CrmCategoryPreferences } from "@/pages/crm/shared";
import { LeadDetailModal } from "@/pages/crm/LeadDetailModal";
import { CRMFilterSettingsDialog } from "@/pages/crm/CRMFilterSettingsDialog";
import { CRMPageHeader } from "@/pages/crm/CRMPageHeader";
import { CRMToolbar } from "@/pages/crm/CRMToolbar";
import { CRMMainContent } from "@/pages/crm/CRMMainContent";
import { ColorSettingsDialog } from "@/pages/crm/ColorSettingsDialog";



export default function CRMPage() {
  const { toast } = useToast();
  const { t } = useTranslation();
  const queryClientRef = useQueryClient();
  const [viewMode, setViewMode] = useState<"kanban" | "list" | "analytics">("kanban");
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [selectedSourceId, setSelectedSourceId] = useState<string>("all");
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [sortBy, setSortBy] = useState<string>("newest");
  const [columnSorts, setColumnSorts] = useState<Record<string, "score" | "date">>({});
  const [listPage, setListPage] = useState(1);
  const [colorSettingsOpen, setColorSettingsOpen] = useState(false);
  const [filterSettingsOpen, setFilterSettingsOpen] = useState(false);
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(new Set());
  const [bulkActionOpen, setBulkActionOpen] = useState(false);
  const [bulkStageDialogOpen, setBulkStageDialogOpen] = useState(false);
  const [bulkTagDialogOpen, setBulkTagDialogOpen] = useState(false);
  const [newTagInput, setNewTagInput] = useState("");
  const LEADS_PER_PAGE = 50;
  
  // AI Category filtering - only show qualified prospects
  const [aiCategoryFilter, setAiCategoryFilter] = useState<AICategory | "all">("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [loadedLeads, setLoadedLeads] = useState<Lead[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [totalLeads, setTotalLeads] = useState(0);
  
  // Column drag-and-drop state
  const [draggingColumnId, setDraggingColumnId] = useState<string | null>(null);
  const [dragOverColumnId, setDragOverColumnId] = useState<string | null>(null);

  const { data: analytics, isLoading: analyticsLoading } = useQuery<CRMAnalytics>({
    queryKey: ["/api/crm/analytics"],
    enabled: viewMode === "analytics",
  });

  const { data: allTags = [] } = useQuery<string[]>({
    queryKey: ["/api/crm/tags"],
  });

  const toggleLeadSelection = (leadId: string) => {
    setSelectedLeadIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(leadId)) {
        newSet.delete(leadId);
      } else {
        newSet.add(leadId);
      }
      return newSet;
    });
  };

  const selectAllLeads = () => {
    if (selectedLeadIds.size === filteredLeads.length) {
      setSelectedLeadIds(new Set());
    } else {
      setSelectedLeadIds(new Set(filteredLeads.map(l => l.id)));
    }
  };

  const clearSelection = () => setSelectedLeadIds(new Set());

  const { data: stages = [], isLoading: stagesLoading } = useQuery<LeadStage[]>({
    queryKey: ["/api/crm/stages"],
  });

  // CRM Category Preferences (colors, column order, sorting)
  const { data: categoryPreferences, isLoading: preferencesLoading } = useQuery<CrmCategoryPreferences>({
    queryKey: ["/api/crm/preferences"],
  });

  // Compute ordered categories based on preferences (excluding hidden ones)
  const orderedCategories = useMemo(() => {
    const defaultOrder = AI_CATEGORIES.map(c => c.id);
    const order = categoryPreferences?.columnOrder || defaultOrder;
    const hiddenCategories = categoryPreferences?.hiddenCategories ?? [];
    
    return order
      .filter(id => AI_CATEGORIES.some(c => c.id === id))
      .filter(id => !hiddenCategories.includes(id)) // Exclude hidden categories
      .map(id => {
        const cat = AI_CATEGORIES.find(c => c.id === id)!;
        const customColor = categoryPreferences?.colorOverrides?.[id];
        return {
          ...cat,
          color: customColor || cat.color,
        };
      });
  }, [categoryPreferences]);

  const updateCategoryColorMutation = useMutation({
    mutationFn: async ({ categoryId, color }: { categoryId: string; color: string }) => {
      return apiRequest("PATCH", `/api/crm/preferences/color/${categoryId}`, { color });
    },
    onMutate: async ({ categoryId, color }: { categoryId: string; color: string }) => {
      await queryClientRef.cancelQueries({ queryKey: ["/api/crm/preferences"] });
      const previousPrefs = queryClientRef.getQueryData<CrmCategoryPreferences>(["/api/crm/preferences"]);
      queryClientRef.setQueryData<CrmCategoryPreferences>(["/api/crm/preferences"], (old) => ({
        id: old?.id ?? '',
        userId: old?.userId ?? '',
        hideLeadsWithoutPhone: old?.hideLeadsWithoutPhone ?? false,
        categoryPipelineMappings: old?.categoryPipelineMappings ?? {},
        hotScoreThreshold: old?.hotScoreThreshold ?? 0,
        warmScoreThreshold: old?.warmScoreThreshold ?? 0,
        hiddenCategories: old?.hiddenCategories ?? [],
        colorOverrides: { ...(old?.colorOverrides || {}), [categoryId]: color },
        columnOrder: old?.columnOrder || [],
        columnSortPreferences: old?.columnSortPreferences || {},
      }));
      return { previousPrefs };
    },
    onError: (error: any, _variables, context) => {
      if (context?.previousPrefs) {
        queryClientRef.setQueryData(["/api/crm/preferences"], context.previousPrefs);
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
    onSettled: () => {
      queryClientRef.invalidateQueries({ queryKey: ["/api/crm/preferences"] });
    },
  });

  const updateColumnOrderMutation = useMutation({
    mutationFn: async (columnOrder: string[]) => {
      return apiRequest("PATCH", "/api/crm/preferences/order", { columnOrder });
    },
    onMutate: async (newOrder: string[]) => {
      await queryClientRef.cancelQueries({ queryKey: ["/api/crm/preferences"] });
      const previousPrefs = queryClientRef.getQueryData<CrmCategoryPreferences>(["/api/crm/preferences"]);
      queryClientRef.setQueryData<CrmCategoryPreferences>(["/api/crm/preferences"], (old) => ({
        id: old?.id ?? '',
        userId: old?.userId ?? '',
        hideLeadsWithoutPhone: old?.hideLeadsWithoutPhone ?? false,
        categoryPipelineMappings: old?.categoryPipelineMappings ?? {},
        hotScoreThreshold: old?.hotScoreThreshold ?? 0,
        warmScoreThreshold: old?.warmScoreThreshold ?? 0,
        hiddenCategories: old?.hiddenCategories ?? [],
        columnOrder: newOrder,
        colorOverrides: old?.colorOverrides || {},
        columnSortPreferences: old?.columnSortPreferences || {},
      }));
      return { previousPrefs };
    },
    onError: (error: any, _variables, context) => {
      if (context?.previousPrefs) {
        queryClientRef.setQueryData(["/api/crm/preferences"], context.previousPrefs);
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
    onSettled: () => {
      queryClientRef.invalidateQueries({ queryKey: ["/api/crm/preferences"] });
    },
  });

  const updateColumnSortMutation = useMutation({
    mutationFn: async ({ categoryId, sortBy }: { categoryId: string; sortBy: 'newest' | 'oldest' | 'score-high' | 'score-low' }) => {
      return apiRequest("PATCH", `/api/crm/preferences/sort/${categoryId}`, { sortBy });
    },
    onSuccess: () => {
      queryClientRef.invalidateQueries({ queryKey: ["/api/crm/preferences"] });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  // Filter settings mutation
  const updateFilterSettingsMutation = useMutation({
    mutationFn: async (settings: {
      hideLeadsWithoutPhone?: boolean;
      categoryPipelineMappings?: Record<string, string>;
      hotScoreThreshold?: number;
      warmScoreThreshold?: number;
      hiddenCategories?: string[];
    }) => {
      return apiRequest("PATCH", "/api/crm/preferences", settings);
    },
    onSuccess: () => {
      queryClientRef.invalidateQueries({ queryKey: ["/api/crm/preferences"] });
      queryClientRef.invalidateQueries({ queryKey: [aiKanbanUrl] });
      queryClientRef.invalidateQueries({ queryKey: [categoryCountsUrl] });
      queryClientRef.invalidateQueries({ queryKey: [categorizedLeadsUrl] });
      toast({ title: "Settings saved", description: "Your filter settings have been updated." });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  // Lead AI category update mutation (for drag-and-drop)
  const updateLeadCategoryMutation = useMutation({
    mutationFn: async ({ leadId, aiCategory }: { leadId: string; aiCategory: AICategory }) => {
      return apiRequest("PATCH", `/api/crm/leads/${leadId}/ai-category`, { aiCategory });
    },
    onMutate: async ({ leadId, aiCategory }) => {
      // Cancel any outgoing refetches
      await queryClientRef.cancelQueries({ queryKey: [aiKanbanUrl] });
      
      // Snapshot the previous value
      const previousData = queryClientRef.getQueryData<AIKanbanResponse>([aiKanbanUrl]);
      
      // Optimistically update the cache
      if (previousData) {
        const newData = { ...previousData, columns: { ...previousData.columns } };
        let movedLead: Lead | undefined;
        
        // Find and remove the lead from its current category
        for (const categoryKey of Object.keys(newData.columns) as AICategory[]) {
          const column = newData.columns[categoryKey];
          if (column) {
            const leadIndex = column.leads.findIndex(l => l.id === leadId);
            if (leadIndex !== -1) {
              movedLead = column.leads[leadIndex];
              newData.columns[categoryKey] = {
                ...column,
                leads: column.leads.filter(l => l.id !== leadId),
                total: column.total - 1,
              };
              break;
            }
          }
        }
        
        // Add the lead to the target category
        if (movedLead && newData.columns[aiCategory]) {
          const updatedLead = { ...movedLead, aiCategory };
          newData.columns[aiCategory] = {
            ...newData.columns[aiCategory],
            leads: [updatedLead, ...newData.columns[aiCategory].leads],
            total: newData.columns[aiCategory].total + 1,
          };
        }
        
        queryClientRef.setQueryData([aiKanbanUrl], newData);
      }
      
      return { previousData };
    },
    onSuccess: () => {
      queryClientRef.invalidateQueries({ predicate: (query) => {
        const key = query.queryKey[0];
        return typeof key === 'string' && (
          key.includes('/api/crm/leads') || 
          key.includes('/api/crm/analytics')
        );
      }});
      toast({ title: "Lead moved" });
    },
    onError: (error: any, _variables, context) => {
      // Rollback on error
      if (context?.previousData) {
        queryClientRef.setQueryData([aiKanbanUrl], context.previousData);
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  // Handle lead drop on a category column
  const handleLeadDrop = (leadId: string, targetCategory: AICategory) => {
    updateLeadCategoryMutation.mutate({ leadId, aiCategory: targetCategory });
  };

  // Column drag-and-drop handlers
  const handleColumnDragStart = (e: React.DragEvent, categoryId: string) => {
    setDraggingColumnId(categoryId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', categoryId);
  };

  const handleColumnDragOver = (e: React.DragEvent, categoryId: string) => {
    e.preventDefault();
    if (draggingColumnId && draggingColumnId !== categoryId) {
      setDragOverColumnId(categoryId);
    }
  };

  const handleColumnDragLeave = () => {
    setDragOverColumnId(null);
  };

  const handleColumnDrop = (e: React.DragEvent, targetCategoryId: string) => {
    e.preventDefault();
    if (!draggingColumnId || draggingColumnId === targetCategoryId) {
      setDraggingColumnId(null);
      setDragOverColumnId(null);
      return;
    }

    const currentOrder = orderedCategories.map(c => c.id) as string[];
    const fromIndex = currentOrder.indexOf(draggingColumnId);
    const toIndex = currentOrder.indexOf(targetCategoryId);
    
    if (fromIndex !== -1 && toIndex !== -1) {
      const newOrder = [...currentOrder];
      newOrder.splice(fromIndex, 1);
      newOrder.splice(toIndex, 0, draggingColumnId);
      updateColumnOrderMutation.mutate(newOrder);
    }
    
    setDraggingColumnId(null);
    setDragOverColumnId(null);
  };

  const handleColumnDragEnd = () => {
    setDraggingColumnId(null);
    setDragOverColumnId(null);
  };

  const updateStageColorMutation = useMutation({
    mutationFn: async ({ stageId, color }: { stageId: string; color: string }) => {
      return apiRequest("PATCH", `/api/crm/stages/${stageId}`, { color });
    },
    onSuccess: () => {
      queryClientRef.invalidateQueries({ queryKey: ["/api/crm/stages"] });
      toast({ title: "Color updated" });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const leadsQueryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (sourceFilter !== "all") {
      params.set("sourceType", sourceFilter);
    }
    if (selectedSourceId !== "all") {
      params.set("sourceId", selectedSourceId);
    }
    return params.toString();
  }, [sourceFilter, selectedSourceId]);

  const leadsUrl = leadsQueryParams ? `/api/crm/leads?${leadsQueryParams}` : "/api/crm/leads";
  
  const { data: leads = [], isLoading: leadsLoading } = useQuery<Lead[]>({
    queryKey: [leadsUrl],
  });

  // AI Category counts for the new CRM view
  const categoryCountsUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (sourceFilter !== "all") {
      params.set("sourceType", sourceFilter);
    }
    if (selectedSourceId !== "all") {
      params.set("sourceId", selectedSourceId);
    }
    return `/api/crm/leads/category-counts${params.toString() ? '?' + params.toString() : ''}`;
  }, [sourceFilter, selectedSourceId]);

  const { data: categoryCounts, isLoading: categoryCountsLoading } = useQuery<CategoryCounts>({
    queryKey: [categoryCountsUrl],
  });

  // AI Kanban query - fetch all 6 categories with leads for Kanban view
  const aiKanbanUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (sourceFilter !== "all") {
      params.set("sourceType", sourceFilter);
    }
    if (selectedSourceId !== "all") {
      params.set("sourceId", selectedSourceId);
    }
    params.set("limit", "20");
    return `/api/crm/leads/ai-kanban?${params.toString()}`;
  }, [sourceFilter, selectedSourceId]);

  const { data: aiKanbanData, isLoading: aiKanbanLoading } = useQuery<AIKanbanResponse>({
    queryKey: [aiKanbanUrl],
    enabled: viewMode === "kanban",
  });

  // Paginated categorized leads
  const categorizedLeadsUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (aiCategoryFilter !== "all") {
      params.set("aiCategory", aiCategoryFilter);
    }
    if (sourceFilter !== "all") {
      params.set("sourceType", sourceFilter);
    }
    if (selectedSourceId !== "all") {
      params.set("sourceId", selectedSourceId);
    }
    if (searchQuery) {
      params.set("search", searchQuery);
    }
    params.set("sortBy", sortBy);
    params.set("limit", LEADS_PER_PAGE.toString());
    params.set("offset", "0");
    return `/api/crm/leads/categorized?${params.toString()}`;
  }, [aiCategoryFilter, sourceFilter, selectedSourceId, searchQuery, sortBy, LEADS_PER_PAGE]);

  const { data: categorizedLeadsData, isLoading: categorizedLeadsLoading } = useQuery<PaginatedLeadsResponse>({
    queryKey: [categorizedLeadsUrl],
  });

  // Update loaded leads when data changes
  useEffect(() => {
    if (categorizedLeadsData) {
      setLoadedLeads(categorizedLeadsData.leads);
      setHasMore(categorizedLeadsData.hasMore);
      setTotalLeads(categorizedLeadsData.total);
    }
  }, [categorizedLeadsData]);

  // Load more function for infinite scroll
  const loadMoreMutation = useMutation({
    mutationFn: async () => {
      const params = new URLSearchParams();
      if (aiCategoryFilter !== "all") {
        params.set("aiCategory", aiCategoryFilter);
      }
      if (sourceFilter !== "all") {
        params.set("sourceType", sourceFilter);
      }
      if (selectedSourceId !== "all") {
        params.set("sourceId", selectedSourceId);
      }
      if (searchQuery) {
        params.set("search", searchQuery);
      }
      params.set("sortBy", sortBy);
      params.set("limit", LEADS_PER_PAGE.toString());
      params.set("offset", loadedLeads.length.toString());
      
      const response = await apiRequest("GET", `/api/crm/leads/categorized?${params.toString()}`);
      return response.json() as Promise<PaginatedLeadsResponse>;
    },
    onSuccess: (data) => {
      setLoadedLeads(prev => [...prev, ...data.leads]);
      setHasMore(data.hasMore);
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const loadMore = () => {
    if (!hasMore || loadMoreMutation.isPending) return;
    loadMoreMutation.mutate();
  };

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ["/api/campaigns"],
  });

  const { data: incomingConnectionsResponse } = useQuery<{ connections: IncomingConnection[] }>({
    queryKey: ["/api/incoming-connections"],
  });
  const incomingConnections = incomingConnectionsResponse?.connections || [];

  // Backfill AI categories mutation
  const backfillCategoriesMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/crm/leads/backfill-categories");
      return response.json();
    },
    onSuccess: (data: { updated: number; total: number }) => {
      queryClientRef.invalidateQueries({ queryKey: [categoryCountsUrl] });
      queryClientRef.invalidateQueries({ queryKey: [aiKanbanUrl] });
      queryClientRef.invalidateQueries({ queryKey: [categorizedLeadsUrl] });
      toast({ 
        title: "Categories Updated", 
        description: `Categorized ${data.updated} of ${data.total} leads` 
      });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateLeadStageMutation = useMutation({
    mutationFn: async ({ leadId, stage, stageId }: { leadId: string; stage: string; stageId: string }) => {
      return apiRequest("PATCH", `/api/crm/leads/${leadId}`, { stage, stageId });
    },
    onSuccess: () => {
      queryClientRef.invalidateQueries({ queryKey: [leadsUrl] });
      toast({ title: "Lead moved" });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const bulkUpdateCategoryMutation = useMutation({
    mutationFn: async ({ leadIds, aiCategory }: { leadIds: string[]; aiCategory: AICategory }) => {
      return apiRequest("POST", "/api/crm/leads/bulk/ai-category", { ids: leadIds, aiCategory });
    },
    onSuccess: (_, variables) => {
      queryClientRef.invalidateQueries({ predicate: (query) => {
        const key = query.queryKey[0];
        return typeof key === 'string' && (
          key.includes('/api/crm/leads') || 
          key.includes('/api/crm/analytics')
        );
      }});
      toast({ title: `${variables.leadIds.length} leads moved` });
      clearSelection();
      setBulkStageDialogOpen(false);
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const bulkAddTagMutation = useMutation({
    mutationFn: async ({ leadIds, tag }: { leadIds: string[]; tag: string }) => {
      return apiRequest("POST", "/api/crm/leads/bulk/tags", { ids: leadIds, tags: [tag] });
    },
    onSuccess: (_, variables) => {
      queryClientRef.invalidateQueries({ queryKey: [leadsUrl] });
      queryClientRef.invalidateQueries({ queryKey: ["/api/crm/tags"] });
      toast({ title: `Tag added to ${variables.leadIds.length} leads` });
      clearSelection();
      setBulkTagDialogOpen(false);
      setNewTagInput("");
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (leadIds: string[]) => {
      return apiRequest("POST", "/api/crm/leads/bulk/delete", { ids: leadIds });
    },
    onSuccess: (_, leadIds) => {
      queryClientRef.invalidateQueries({ queryKey: [leadsUrl] });
      toast({ title: `${leadIds.length} leads deleted` });
      clearSelection();
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleExportCSV = async () => {
    try {
      const { AuthStorage } = await import("@/lib/auth-storage");
      const headers: Record<string, string> = {};
      const authHeader = AuthStorage.getAuthHeader();
      if (authHeader) {
        headers["Authorization"] = authHeader;
      }
      
      const response = await fetch("/api/crm/export/csv", {
        method: "GET",
        credentials: "include",
        headers,
      });
      if (!response.ok) {
        throw new Error("Export failed");
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `leads-export-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      toast({ title: "Export complete" });
    } catch (error) {
      toast({ title: "Export failed", variant: "destructive" });
    }
  };

  const filteredLeads = useMemo(() => {
    let result = [...leads];

    // Filter by AI category card selection
    if (aiCategoryFilter !== "all") {
      result = result.filter(lead => lead.aiCategory === aiCategoryFilter);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(lead => 
        lead.phone.toLowerCase().includes(query) ||
        (lead.firstName?.toLowerCase().includes(query)) ||
        (lead.lastName?.toLowerCase().includes(query)) ||
        (lead.email?.toLowerCase().includes(query)) ||
        (lead.tags?.some(tag => tag.toLowerCase().includes(query)))
      );
    }

    // Filter by tag
    if (tagFilter !== "all") {
      result = result.filter(lead => lead.tags?.includes(tagFilter));
    }

    if (sourceFilter === "campaign") {
      result = result.filter(lead => lead.sourceType === "campaign");
      if (selectedSourceId !== "all") {
        result = result.filter(lead => lead.campaignId === selectedSourceId);
      }
    } else if (sourceFilter === "incoming") {
      result = result.filter(lead => lead.sourceType === "incoming");
      if (selectedSourceId !== "all") {
        result = result.filter(lead => lead.incomingConnectionId === selectedSourceId);
      }
    }

    if (sortBy === "newest") {
      result.sort((a, b) => new Date(b.lastCallAt || b.updatedAt || b.createdAt).getTime() - new Date(a.lastCallAt || a.updatedAt || a.createdAt).getTime());
    } else if (sortBy === "oldest") {
      result.sort((a, b) => new Date(a.lastCallAt || a.updatedAt || a.createdAt).getTime() - new Date(b.lastCallAt || b.updatedAt || b.createdAt).getTime());
    } else if (sortBy === "score-high") {
      result.sort((a, b) => (b.leadScore || 0) - (a.leadScore || 0));
    } else if (sortBy === "score-low") {
      result.sort((a, b) => (a.leadScore || 0) - (b.leadScore || 0));
    }

    return result;
  }, [leads, searchQuery, sourceFilter, selectedSourceId, sortBy, tagFilter, aiCategoryFilter]);

  const leadsByStage = useMemo(() => {
    const result: Record<string, Lead[]> = {};
    stages.forEach(stage => {
      const stageSlug = stage.name.toLowerCase().replace(/\s+/g, "_").replace(/_lead$/, "").replace(/_booked$/, "").replace(/^needs_/, "");
      let stageLeads = filteredLeads.filter(lead => {
        const leadStageSlug = lead.stage.toLowerCase().replace(/\s+/g, "_");
        return lead.stageId === stage.id || leadStageSlug === stageSlug || lead.stage === stage.name;
      });
      
      const columnSort = columnSorts[stage.id];
      if (columnSort === "score") {
        stageLeads.sort((a, b) => (b.leadScore || 0) - (a.leadScore || 0));
      } else if (columnSort === "date") {
        stageLeads.sort((a, b) => new Date(b.lastCallAt || b.updatedAt || b.createdAt).getTime() - new Date(a.lastCallAt || a.updatedAt || a.createdAt).getTime());
      }
      
      result[stage.id] = stageLeads;
    });
    return result;
  }, [stages, filteredLeads, columnSorts]);

  const sortedStages = useMemo(() => {
    return [...stages].sort((a, b) => a.order - b.order);
  }, [stages]);

  const handleDrop = (leadId: string, newStage: string, newStageId: string) => {
    updateLeadStageMutation.mutate({ leadId, stage: newStage, stageId: newStageId });
  };

  const handleColumnSort = (stageId: string, sortType: "score" | "date") => {
    setColumnSorts(prev => ({ ...prev, [stageId]: sortType }));
    toast({ title: `Sorted by ${sortType === "score" ? "score" : "date"}` });
  };

  const totalPages = Math.max(1, Math.ceil(filteredLeads.length / LEADS_PER_PAGE));
  
  useEffect(() => {
    if (listPage > totalPages) {
      setListPage(totalPages);
    }
  }, [totalPages, listPage]);

  useEffect(() => {
    setListPage(1);
  }, [searchQuery, sourceFilter, selectedSourceId]);

  const paginatedLeads = useMemo(() => {
    const startIndex = (listPage - 1) * LEADS_PER_PAGE;
    return filteredLeads.slice(startIndex, startIndex + LEADS_PER_PAGE);
  }, [filteredLeads, listPage, LEADS_PER_PAGE]);

  const isLoading = stagesLoading || leadsLoading;

  return (
    <div className="flex flex-col h-full bg-background" data-testid="crm-page">
      <CRMPageHeader
        t={t}
        handleExportCSV={handleExportCSV}
        setFilterSettingsOpen={setFilterSettingsOpen}
        aiCategoryFilter={aiCategoryFilter}
        setAiCategoryFilter={setAiCategoryFilter}
        setListPage={setListPage}
        categoryCounts={categoryCounts}
        orderedCategories={orderedCategories}
      />

      <CRMToolbar
        t={t}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        sourceFilter={sourceFilter}
        setSourceFilter={setSourceFilter}
        setSelectedSourceId={setSelectedSourceId}
        campaigns={campaigns}
        selectedSourceId={selectedSourceId}
        incomingConnections={incomingConnections}
        allTags={allTags}
        tagFilter={tagFilter}
        setTagFilter={setTagFilter}
        backfillCategoriesMutation={backfillCategoriesMutation}
        queryClientRef={queryClientRef}
        viewMode={viewMode}
        setViewMode={setViewMode}
      />

      {selectedLeadIds.size > 0 && (
        <div className="flex items-center gap-3 px-6 py-2 border-b bg-primary/5">
          <div className="flex items-center gap-2">
            <Checkbox
              checked={selectedLeadIds.size === filteredLeads.length && filteredLeads.length > 0}
              onCheckedChange={selectAllLeads}
              data-testid="select-all-leads"
            />
            <span className="text-sm font-medium">{t("crmPage.selected", { count: selectedLeadIds.size })}</span>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setBulkStageDialogOpen(true)}
              data-testid="bulk-change-stage"
            >
              <ArrowRightLeft className="w-4 h-4 mr-2" />
              {t("crmPage.moveToCategory")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setBulkTagDialogOpen(true)}
              data-testid="bulk-add-tag"
            >
              <Tag className="w-4 h-4 mr-2" />
              {t("crmPage.addTag")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (confirm(t("crmPage.deleteConfirm", { count: selectedLeadIds.size }))) {
                  bulkDeleteMutation.mutate(Array.from(selectedLeadIds));
                }
              }}
              className="text-destructive hover:text-destructive"
              data-testid="bulk-delete"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {t("crmPage.delete")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearSelection}
              data-testid="clear-selection"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      <Dialog open={bulkStageDialogOpen} onOpenChange={setBulkStageDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("crmPage.moveLeadsToCategory", { count: selectedLeadIds.size })}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 py-4">
            {AI_CATEGORIES.map(cat => {
              const Icon = cat.icon;
              return (
                <Button
                  key={cat.id}
                  variant="outline"
                  className="justify-start"
                  onClick={() => bulkUpdateCategoryMutation.mutate({
                    leadIds: Array.from(selectedLeadIds),
                    aiCategory: cat.id,
                  })}
                  disabled={bulkUpdateCategoryMutation.isPending}
                  data-testid={`bulk-category-${cat.id}`}
                >
                  <Icon className="w-4 h-4 mr-2" style={{ color: cat.color }} />
                  {t(`crmPage.categories.${cat.id}`, { defaultValue: cat.label })}
                </Button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkTagDialogOpen} onOpenChange={setBulkTagDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("crmPage.addTagToLeads", { count: selectedLeadIds.size })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="flex gap-2">
              <Input
                placeholder={t("crmPage.enterNewTag")}
                value={newTagInput}
                onChange={(e) => setNewTagInput(e.target.value)}
                data-testid="new-tag-input"
              />
              <Button
                onClick={() => newTagInput.trim() && bulkAddTagMutation.mutate({
                  leadIds: Array.from(selectedLeadIds),
                  tag: newTagInput.trim()
                })}
                disabled={!newTagInput.trim() || bulkAddTagMutation.isPending}
                data-testid="add-new-tag"
              >
                {t("crmPage.add")}
              </Button>
            </div>
            {allTags.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{t("crmPage.orSelectExisting")}</p>
                <div className="flex flex-wrap gap-2">
                  {allTags.map(tag => (
                    <Badge
                      key={tag}
                      variant="outline"
                      className="cursor-pointer hover-elevate"
                      onClick={() => bulkAddTagMutation.mutate({
                        leadIds: Array.from(selectedLeadIds),
                        tag
                      })}
                      data-testid={`existing-tag-${tag}`}
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <CRMMainContent
        isLoading={isLoading}
        viewMode={viewMode}
        analyticsLoading={analyticsLoading}
        analytics={analytics}
        t={t}
        aiKanbanLoading={aiKanbanLoading}
        preferencesLoading={preferencesLoading}
        aiKanbanData={aiKanbanData}
        orderedCategories={orderedCategories}
        aiCategoryFilter={aiCategoryFilter}
        categoryPreferences={categoryPreferences}
        searchQuery={searchQuery}
        tagFilter={tagFilter}
        setSelectedLead={setSelectedLead}
        selectedLeadIds={selectedLeadIds}
        toggleLeadSelection={toggleLeadSelection}
        updateColumnSortMutation={updateColumnSortMutation}
        updateCategoryColorMutation={updateCategoryColorMutation}
        handleLeadDrop={handleLeadDrop}
        draggingColumnId={draggingColumnId}
        dragOverColumnId={dragOverColumnId}
        handleColumnDragStart={handleColumnDragStart}
        handleColumnDragOver={handleColumnDragOver}
        handleColumnDragLeave={handleColumnDragLeave}
        handleColumnDrop={handleColumnDrop}
        handleColumnDragEnd={handleColumnDragEnd}
        paginatedLeads={paginatedLeads}
        stages={stages}
        filteredLeads={filteredLeads}
        totalPages={totalPages}
        listPage={listPage}
        LEADS_PER_PAGE={LEADS_PER_PAGE}
        setListPage={setListPage}
      />

      <LeadDetailModal 
        lead={selectedLead} 
        open={!!selectedLead} 
        onClose={() => setSelectedLead(null)}
        stageColor={selectedLead ? stages.find(s => s.id === selectedLead.stageId)?.color : undefined}
      />

      <ColorSettingsDialog
        colorSettingsOpen={colorSettingsOpen}
        setColorSettingsOpen={setColorSettingsOpen}
        sortedStages={sortedStages}
        updateStageColorMutation={updateStageColorMutation}
      />

      {/* CRM Filter Settings Dialog */}
      <CRMFilterSettingsDialog
        open={filterSettingsOpen}
        onOpenChange={setFilterSettingsOpen}
        categoryPreferences={categoryPreferences}
        stages={stages}
        onSave={(settings) => updateFilterSettingsMutation.mutate(settings)}
        isSaving={updateFilterSettingsMutation.isPending}
      />
    </div>
  );
}
