import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { AuthStorage } from "@/lib/auth-storage";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Plus, Globe, Copy, Trash2, Edit, Phone, Clock, Code, RefreshCw, MoreVertical, X, Loader2, BarChart3, PhoneCall, Timer, MessageCircle, AlertCircle, Upload, ChevronDown, Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { WebsiteWidget, Agent } from "@shared/schema";
import { useTranslation } from "react-i18next";
import { TIMEZONE_OPTIONS, DAY_OPTIONS, COLOR_PRESETS, WidgetFormData, WidgetStats, WidgetLimits, defaultFormData } from "./widgets/types";
import { InteractiveWidgetPreview } from "./widgets/InteractiveWidgetPreview";

/** Widget fields the API may return that are not on WebsiteWidget. */
type WidgetLegacyFields = { buttonLabel?: string; iconPath?: string; requireTermsAcceptance?: boolean; appointmentBookingEnabled?: boolean; cooldownMinutes?: number };

export default function WidgetsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [mainTab, setMainTab] = useState("widgets");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingWidget, setEditingWidget] = useState<WebsiteWidget | null>(null);
  const [formData, setFormData] = useState<WidgetFormData>(defaultFormData);
  const [domainInput, setDomainInput] = useState("");
  const [activeTab, setActiveTab] = useState("general");
  const [embedCodeWidget, setEmbedCodeWidget] = useState<WebsiteWidget | null>(null);
  const [embedCode, setEmbedCode] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: widgets = [], isLoading } = useQuery<WebsiteWidget[]>({
    queryKey: ["/api/widgets"],
  });

  const { data: agents = [] } = useQuery<Agent[]>({
    queryKey: ["/api/agents"],
  });

  const { data: stats } = useQuery<WidgetStats>({
    queryKey: ["/api/widgets-stats"],
  });

  const { data: limits } = useQuery<WidgetLimits>({
    queryKey: ["/api/widgets-limits"],
  });

  const { data: branding } = useQuery<{ app_name: string }>({
    queryKey: ["/api/branding"],
  });
  const appName = branding?.app_name || "";

  const createMutation = useMutation({
    mutationFn: async (data: WidgetFormData) => {
      const formDataToSend = new FormData();
      formDataToSend.append('name', data.name);
      formDataToSend.append('status', data.status);
      formDataToSend.append('agentId', data.agentId || '');
      formDataToSend.append('agentType', data.agentType);
      formDataToSend.append('brandName', data.brandName);
      formDataToSend.append('buttonLabel', data.buttonLabel);
      formDataToSend.append('primaryColor', data.primaryColor);
      formDataToSend.append('backgroundColor', data.backgroundColor);
      formDataToSend.append('textColor', data.textColor);
      formDataToSend.append('requireTermsAcceptance', String(data.requireTermsAcceptance));
      formDataToSend.append('appointmentBookingEnabled', String(data.appointmentBookingEnabled));
      formDataToSend.append('allowedDomains', JSON.stringify(data.allowedDomains));
      formDataToSend.append('businessHoursEnabled', String(data.businessHoursEnabled));
      formDataToSend.append('businessHoursStart', data.businessHoursStart);
      formDataToSend.append('businessHoursEnd', data.businessHoursEnd);
      formDataToSend.append('businessDays', JSON.stringify(data.businessDays));
      formDataToSend.append('businessTimezone', data.businessTimezone);
      formDataToSend.append('maxConcurrentCalls', String(data.maxConcurrentCalls));
      formDataToSend.append('maxCallDuration', String(data.maxCallDuration));
      formDataToSend.append('cooldownMinutes', String(data.cooldownMinutes));
      
      if (data.iconFile) {
        formDataToSend.append('icon', data.iconFile);
      }

      const response = await fetch('/api/widgets', {
        method: 'POST',
        headers: {
          'Authorization': AuthStorage.getAuthHeader() || '',
        },
        body: formDataToSend,
        credentials: 'include',
      });
      if (!response.ok) {
        let errMessage = `Server error (${response.status}): Failed to create widget`;
        try {
          const err = await response.json();
          errMessage = err.message || err.error || errMessage;
        } catch {}
        throw new Error(errMessage);
      }
      try {
        return await response.json();
      } catch {
        throw new Error('Server returned an unexpected response. Please try again.');
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/widgets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/widgets-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/widgets-limits"] });
      setIsCreateOpen(false);
      resetForm();
      toast({ title: t('widgetsPage.toasts.created', 'Widget created'), description: t('widgetsPage.toasts.createdDesc', 'Your website widget has been created successfully.') });
    },
    onError: (error: Error) => {
      const message = error?.message || t('common.error', 'Error');
      toast({ title: t('common.error', 'Error'), description: message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: WidgetFormData }) => {
      const formDataToSend = new FormData();
      formDataToSend.append('name', data.name);
      formDataToSend.append('status', data.status);
      formDataToSend.append('agentId', data.agentId || '');
      formDataToSend.append('agentType', data.agentType);
      formDataToSend.append('brandName', data.brandName);
      formDataToSend.append('buttonLabel', data.buttonLabel);
      formDataToSend.append('primaryColor', data.primaryColor);
      formDataToSend.append('backgroundColor', data.backgroundColor);
      formDataToSend.append('textColor', data.textColor);
      formDataToSend.append('requireTermsAcceptance', String(data.requireTermsAcceptance));
      formDataToSend.append('appointmentBookingEnabled', String(data.appointmentBookingEnabled));
      formDataToSend.append('allowedDomains', JSON.stringify(data.allowedDomains));
      formDataToSend.append('businessHoursEnabled', String(data.businessHoursEnabled));
      formDataToSend.append('businessHoursStart', data.businessHoursStart);
      formDataToSend.append('businessHoursEnd', data.businessHoursEnd);
      formDataToSend.append('businessDays', JSON.stringify(data.businessDays));
      formDataToSend.append('businessTimezone', data.businessTimezone);
      formDataToSend.append('maxConcurrentCalls', String(data.maxConcurrentCalls));
      formDataToSend.append('maxCallDuration', String(data.maxCallDuration));
      formDataToSend.append('cooldownMinutes', String(data.cooldownMinutes));
      
      if (data.iconFile) {
        formDataToSend.append('icon', data.iconFile);
      }

      const response = await fetch(`/api/widgets/${id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': AuthStorage.getAuthHeader() || '',
        },
        body: formDataToSend,
        credentials: 'include',
      });
      if (!response.ok) {
        let errMessage = `Server error (${response.status}): Failed to update widget`;
        try {
          const err = await response.json();
          errMessage = err.message || err.error || errMessage;
        } catch {}
        throw new Error(errMessage);
      }
      try {
        return await response.json();
      } catch {
        throw new Error('Server returned an unexpected response. Please try again.');
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/widgets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/widgets-stats"] });
      setEditingWidget(null);
      resetForm();
      toast({ title: t('widgetsPage.toasts.updated', 'Widget updated'), description: t('widgetsPage.toasts.updatedDesc', 'Your widget has been updated successfully.') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error', 'Error'), description: error.message || t('widgetsPage.toasts.updatedFailed', 'Failed to update widget'), variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/widgets/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/widgets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/widgets-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/widgets-limits"] });
      toast({ title: t('widgetsPage.toasts.deleted', 'Widget deleted'), description: t('widgetsPage.toasts.deletedDesc', 'Your widget has been deleted.') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error', 'Error'), description: error.message || t('widgetsPage.toasts.deleteFailed', 'Failed to delete widget'), variant: "destructive" });
    },
  });

  const regenerateTokenMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/widgets/${id}/regenerate-token`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/widgets"] });
      toast({ title: t('widgetsPage.toasts.tokenRegenerated', 'Token regenerated'), description: t('widgetsPage.toasts.tokenRegeneratedDesc', 'A new embed token has been generated.') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error', 'Error'), description: error.message || t('widgetsPage.toasts.regenerateFailed', 'Failed to regenerate token'), variant: "destructive" });
    },
  });

  const resetForm = () => {
    setFormData(defaultFormData);
    setDomainInput("");
    setActiveTab("general");
    setAdvancedOpen(false);
  };

  const openEditModal = (widget: WebsiteWidget) => {
    setEditingWidget(widget);
    setFormData({
      name: widget.name,
      status: widget.status,
      agentId: widget.agentId,
      agentType: widget.agentType,
      brandName: widget.brandName || "",
      buttonLabel: (widget as WebsiteWidget & WidgetLegacyFields).buttonLabel || "VOICE CHAT",
      primaryColor: widget.primaryColor,
      backgroundColor: widget.backgroundColor,
      textColor: widget.textColor,
      iconFile: null,
      iconPreview: widget.iconUrl || (widget as WebsiteWidget & WidgetLegacyFields).iconPath || null,
      requireTermsAcceptance: (widget as WebsiteWidget & WidgetLegacyFields).requireTermsAcceptance || false,
      appointmentBookingEnabled: (widget as WebsiteWidget & WidgetLegacyFields).appointmentBookingEnabled || false,
      allowedDomains: widget.allowedDomains || [],
      businessHoursEnabled: widget.businessHoursEnabled,
      businessHoursStart: widget.businessHoursStart || "09:00",
      businessHoursEnd: widget.businessHoursEnd || "17:00",
      businessDays: widget.businessDays || ["monday", "tuesday", "wednesday", "thursday", "friday"],
      businessTimezone: widget.businessTimezone || "America/New_York",
      maxConcurrentCalls: widget.maxConcurrentCalls,
      maxCallDuration: widget.maxCallDuration,
      cooldownMinutes: (widget as WebsiteWidget & WidgetLegacyFields).cooldownMinutes || 0,
    });
    setActiveTab("general");
  };

  const handleSubmit = () => {
    if (!formData.name.trim()) {
      toast({ title: t('common.error', 'Error'), description: t('widgetsPage.errors.nameRequired', 'Widget name is required'), variant: "destructive" });
      return;
    }
    if (editingWidget) {
      updateMutation.mutate({ id: editingWidget.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const addDomain = () => {
    const domain = domainInput.trim().toLowerCase();
    if (domain && !formData.allowedDomains.includes(domain)) {
      setFormData({ ...formData, allowedDomains: [...formData.allowedDomains, domain] });
      setDomainInput("");
    }
  };

  const removeDomain = (domain: string) => {
    setFormData({ ...formData, allowedDomains: formData.allowedDomains.filter(d => d !== domain) });
  };

  const toggleDay = (day: string) => {
    if (formData.businessDays.includes(day)) {
      setFormData({ ...formData, businessDays: formData.businessDays.filter(d => d !== day) });
    } else {
      setFormData({ ...formData, businessDays: [...formData.businessDays, day] });
    }
  };

  const handleIconUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        toast({ title: t('common.error', 'Error'), description: t('errors.invalidFile', 'Please select an image file'), variant: "destructive" });
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        toast({ title: t('common.error', 'Error'), description: t('errors.fileTooLarge', 'Image must be less than 2MB'), variant: "destructive" });
        return;
      }
      const reader = new FileReader();
      reader.onload = (event) => {
        setFormData({ 
          ...formData, 
          iconFile: file,
          iconPreview: event.target?.result as string 
        });
      };
      reader.readAsDataURL(file);
    }
  };

  const removeIcon = () => {
    setFormData({ ...formData, iconFile: null, iconPreview: null });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const fetchEmbedCode = async (widget: WebsiteWidget) => {
    try {
      const response = await apiRequest("GET", `/api/widgets/${widget.id}/embed-code`);
      const data = await response.json();
      if (data.embedCode) {
        setEmbedCode(data.embedCode);
        setEmbedCodeWidget(widget);
      } else {
        toast({ title: t('common.error', 'Error'), description: t('widgetsPage.errors.embedFailed', 'Failed to generate embed code'), variant: "destructive" });
      }
    } catch (error) {
      toast({ title: t('common.error', 'Error'), description: t('widgetsPage.errors.embedFetchFailed', 'Failed to fetch embed code'), variant: "destructive" });
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: t('widgetsPage.dialogs.copied', 'Copied'), description: t('widgetsPage.dialogs.copySuccess', 'Embed code copied to clipboard') });
  };

  const isModalOpen = isCreateOpen || editingWidget !== null;
  const isSubmitting = createMutation.isPending || updateMutation.isPending;
  const isUnlimitedWidgets = limits?.maxWidgets === -1 || (limits?.maxWidgets ?? 0) >= 999;
  const canCreateWidget = limits ? (isUnlimitedWidgets || limits.remaining > 0) : true;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 md:p-6 border-b">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold" data-testid="text-page-title">{t('widgetsPage.title', 'Website Widgets')}</h1>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-4 w-4 text-muted-foreground cursor-help" data-testid="icon-widget-info" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs">
                <p className="text-sm">
                  {t('widgetsPage.infoTooltip', 'Widgets are designed for sharing information with website visitors and appointment booking. Features like campaigns and CRM are not available for widget calls.')}
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
          <p className="text-muted-foreground">{t('widgetsPage.description', 'Create embeddable voice widgets for your websites')}</p>
        </div>
        <div className="flex items-center gap-3">
          {limits && (
            <div className="text-sm text-muted-foreground">
              {t('widgetsPage.widgetsCount', { current: limits.currentCount, max: limits.maxWidgets === -1 || limits.maxWidgets >= 999 ? t('widgetsPage.unlimited', 'Unlimited') : limits.maxWidgets, defaultValue: `${limits.currentCount}/${limits.maxWidgets === -1 || limits.maxWidgets >= 999 ? 'Unlimited' : limits.maxWidgets} widgets` })}
            </div>
          )}
          <Button 
            onClick={() => { resetForm(); setIsCreateOpen(true); }} 
            disabled={!canCreateWidget}
            data-testid="button-create-widget"
          >
            <Plus className="h-4 w-4 mr-2" />
            {t('widgetsPage.createWidget', 'Create Widget')}
          </Button>
        </div>
      </div>

      <Tabs value={mainTab} onValueChange={setMainTab} className="flex-1 flex flex-col">
        <div className="border-b px-4 md:px-6">
          <TabsList className="h-auto p-0 bg-transparent">
            <TabsTrigger 
              value="widgets" 
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
            >
              <Globe className="h-4 w-4 mr-2" />
              {t('widgetsPage.tabs.widgets', 'Widgets')}
            </TabsTrigger>
            <TabsTrigger 
              value="dashboard" 
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
            >
              <BarChart3 className="h-4 w-4 mr-2" />
              {t('widgetsPage.tabs.analytics', 'Analytics')}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="widgets" className="flex-1 overflow-auto p-4 md:p-6 mt-0">
          {!canCreateWidget && (
            <div className="mb-4 p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-900 dark:text-amber-100">{t('widgetsPage.limitReached.title', 'Widget limit reached')}</p>
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  {t('widgetsPage.limitReached.description', { max: limits?.maxWidgets === -1 || (limits?.maxWidgets ?? 0) >= 999 ? t('widgetsPage.unlimited', 'Unlimited') : limits?.maxWidgets, defaultValue: `Your plan allows ${limits?.maxWidgets === -1 || (limits?.maxWidgets ?? 0) >= 999 ? 'Unlimited' : limits?.maxWidgets} widget(s). Upgrade your plan to create more widgets.` })}
                </p>
              </div>
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : widgets.length === 0 ? (
            <Card className="flex flex-col items-center justify-center h-64">
              <Globe className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">{t('widgetsPage.noWidgets.title', 'No widgets yet')}</h3>
              <p className="text-muted-foreground text-center mb-4 max-w-md">
                {t('widgetsPage.noWidgets.description', 'Create your first website widget to enable voice conversations on your website.')}
              </p>
              <Button onClick={() => { resetForm(); setIsCreateOpen(true); }} disabled={!canCreateWidget} data-testid="button-create-first-widget">
                <Plus className="h-4 w-4 mr-2" />
                {t('widgetsPage.createWidget', 'Create Widget')}
              </Button>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {widgets.map((widget) => (
                <Card key={widget.id} className="relative" data-testid={`card-widget-${widget.id}`}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-3 min-w-0">
                        <div 
                          className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0 overflow-hidden"
                          style={{ backgroundColor: widget.primaryColor }}
                        >
                          {widget.iconUrl || (widget as WebsiteWidget & WidgetLegacyFields).iconPath ? (
                            <img src={widget.iconUrl || (widget as WebsiteWidget & WidgetLegacyFields).iconPath} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <Phone className="h-5 w-5 text-white" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <CardTitle className="text-base truncate">{widget.name}</CardTitle>
                          <CardDescription className="truncate">
                            {widget.brandName || t('widgetsPage.noBrandName', 'No brand name')}
                          </CardDescription>
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="shrink-0" data-testid={`button-widget-menu-${widget.id}`}>
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEditModal(widget)} data-testid={`button-edit-widget-${widget.id}`}>
                            <Edit className="h-4 w-4 mr-2" />
                            {t('widgetsPage.menu.edit', 'Edit')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => fetchEmbedCode(widget)} data-testid={`button-embed-code-${widget.id}`}>
                            <Code className="h-4 w-4 mr-2" />
                            {t('widgetsPage.menu.getEmbedCode', 'Get Embed Code')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => regenerateTokenMutation.mutate(widget.id)}>
                            <RefreshCw className="h-4 w-4 mr-2" />
                            {t('widgetsPage.menu.regenerateToken', 'Regenerate Token')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={() => deleteMutation.mutate(widget.id)}
                            className="text-destructive"
                            data-testid={`button-delete-widget-${widget.id}`}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            {t('widgetsPage.menu.delete', 'Delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-2 mb-3">
                      <Badge variant={widget.status === "active" ? "default" : "secondary"}>
                        {widget.status === "active" ? t('widgetsPage.dialogs.form.active', 'Active') : t('widgetsPage.dialogs.form.paused', 'Paused')}
                      </Badge>
                      {widget.businessHoursEnabled && (
                        <Badge variant="outline">
                          <Clock className="h-3 w-3 mr-1" />
                          {t('widgetsPage.dialogs.form.days', 'Hours')}
                        </Badge>
                      )}
                      {(widget as WebsiteWidget & WidgetLegacyFields).requireTermsAcceptance && (
                        <Badge variant="outline">Terms</Badge>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm text-muted-foreground">
                      <div>
                        <span className="font-medium">{widget.totalCalls}</span> {t('widgetsPage.stats.calls', 'calls')}
                      </div>
                      <div>
                        <span className="font-medium">{widget.totalMinutes}</span> {t('widgetsPage.stats.minutes', 'minutes')}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="dashboard" className="flex-1 overflow-auto p-4 md:p-6 mt-0">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
                <CardTitle className="text-sm font-medium">{t('widgetsPage.stats.totalWidgets', 'Total Widgets')}</CardTitle>
                <Globe className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.totalWidgets || 0}</div>
                {limits && (
                  <div className="mt-2">
                    <Progress value={(limits.currentCount / (limits.maxWidgets === -1 ? limits.currentCount || 1 : limits.maxWidgets)) * 100} className="h-1" />
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('widgetsPage.stats.remaining', { count: limits.remaining, max: limits.maxWidgets === -1 || limits.maxWidgets >= 999 ? t('widgetsPage.unlimited', 'Unlimited') : limits.maxWidgets, defaultValue: `${limits.remaining} of ${limits.maxWidgets === -1 || limits.maxWidgets >= 999 ? 'Unlimited' : limits.maxWidgets} remaining` })}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
            
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
                <CardTitle className="text-sm font-medium">{t('widgetsPage.stats.totalCalls', 'Total Calls')}</CardTitle>
                <PhoneCall className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.totalCalls || 0}</div>
                <p className="text-xs text-muted-foreground">{t('widgetsPage.stats.allTimeCalls', 'All-time widget calls')}</p>
              </CardContent>
            </Card>
            
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
                <CardTitle className="text-sm font-medium">{t('widgetsPage.stats.totalMinutes', 'Total Minutes')}</CardTitle>
                <Timer className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.totalMinutes || 0}</div>
                <p className="text-xs text-muted-foreground">{t('widgetsPage.stats.conversationTime', 'Voice conversation time')}</p>
              </CardContent>
            </Card>
            
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
                <CardTitle className="text-sm font-medium">{t('widgetsPage.stats.activeWidgets', 'Active Widgets')}</CardTitle>
                <MessageCircle className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {stats?.widgetStats?.filter(w => w.status === 'active').length || 0}
                </div>
                <p className="text-xs text-muted-foreground">{t('widgetsPage.stats.readyToReceive', 'Ready to receive calls')}</p>
              </CardContent>
            </Card>
          </div>

          {stats?.widgetStats && stats.widgetStats.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('widgetsPage.stats.performance', 'Widget Performance')}</CardTitle>
                <CardDescription>{t('widgetsPage.stats.performanceDesc', 'Call statistics per widget')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {stats.widgetStats.map((widget) => (
                    <div key={widget.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                          <Globe className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <p className="font-medium">{widget.name}</p>
                          <Badge variant={widget.status === 'active' ? 'default' : 'secondary'} className="text-xs">
                            {widget.status === 'active' ? t('widgetsPage.dialogs.form.active', 'Active') : t('widgetsPage.dialogs.form.paused', 'Paused')}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex items-center gap-6 text-sm">
                        <div className="text-center">
                          <p className="font-semibold">{widget.calls}</p>
                          <p className="text-muted-foreground text-xs">{t('widgetsPage.stats.calls', 'calls')}</p>
                        </div>
                        <div className="text-center">
                          <p className="font-semibold">{widget.minutes}</p>
                          <p className="text-muted-foreground text-xs">{t('widgetsPage.stats.minutes', 'minutes')}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="flex flex-col items-center justify-center py-12">
              <BarChart3 className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">{t('widgetsPage.stats.noData', 'No data yet')}</h3>
              <p className="text-muted-foreground text-center max-w-md">
                {t('widgetsPage.stats.noDataDesc', 'Create widgets and start receiving calls to see your analytics here.')}
              </p>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={isModalOpen} onOpenChange={(open) => {
        if (!open) {
          setIsCreateOpen(false);
          setEditingWidget(null);
          resetForm();
        }
      }}>
        <DialogContent className="w-[calc(100vw-1rem)] sm:w-[calc(100vw-2rem)] max-w-5xl max-h-[100dvh] sm:max-h-[90vh] overflow-y-auto lg:overflow-hidden flex flex-col p-4 sm:p-6">
          <DialogHeader className="shrink-0">
            <DialogTitle>{editingWidget ? t('widgetsPage.dialogs.editTitle', 'Edit Widget') : t('widgetsPage.dialogs.createTitle', 'Create Widget')}</DialogTitle>
            <DialogDescription>
              {editingWidget ? t('widgetsPage.dialogs.editDesc', 'Update your website widget settings') : t('widgetsPage.dialogs.createDesc', 'Configure your new website voice widget')}
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex-1 lg:overflow-hidden flex flex-col lg:flex-row gap-4 lg:gap-6 min-h-0">
            <div className="flex-1 lg:overflow-hidden flex flex-col min-w-0 min-h-0">
              <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 lg:overflow-hidden flex flex-col min-h-0">
                <TabsList className="grid w-full grid-cols-3 shrink-0">
                  <TabsTrigger value="general" className="text-xs sm:text-sm">{t('widgetsPage.dialogs.tabs.general', 'General')}</TabsTrigger>
                  <TabsTrigger value="branding" className="text-xs sm:text-sm">{t('widgetsPage.dialogs.tabs.branding', 'Branding')}</TabsTrigger>
                  <TabsTrigger value="settings" className="text-xs sm:text-sm">{t('widgetsPage.dialogs.tabs.settings', 'Settings')}</TabsTrigger>
                </TabsList>
                
                <ScrollArea className="flex-1 mt-4 min-h-0">
                  <div className="pr-4 pb-4">
                  <TabsContent value="general" className="mt-0 space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">{t('widgetsPage.dialogs.form.name', 'Widget Name *')}</Label>
                      <Input
                        id="name"
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        placeholder={t('widgetsPage.dialogs.form.namePlaceholder', 'My Website Widget')}
                        data-testid="input-widget-name"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="agent">{t('widgetsPage.dialogs.form.agent', 'AI Agent')}</Label>
                      <Select
                        value={formData.agentId || "none"}
                        onValueChange={(value) => setFormData({ ...formData, agentId: value === "none" ? null : value })}
                      >
                        <SelectTrigger data-testid="select-agent">
                          <SelectValue placeholder={t('widgetsPage.dialogs.form.noAgent', 'No agent (use default)')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">{t('widgetsPage.dialogs.form.noAgent', 'No agent (use default)')}</SelectItem>
                          {agents
                            .filter((agent) => {
                              // Only show incoming agents (not flow agents) for widgets
                              // Flow agents don't work reliably with WebSocket-based widget audio
                              if (agent.type !== 'incoming') return false;
                              const sipProviders = ['elevenlabs-sip', 'openai-sip'];
                              return !sipProviders.includes(agent.telephonyProvider || '');
                            })
                            .map((agent) => (
                            <SelectItem key={agent.id} value={agent.id}>
                              {agent.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {t('widgetsPage.dialogs.form.agentHelp', 'Select an incoming AI agent to power this widget (flow agents are not supported)')}
                      </p>
                    </div>

                    <div className="flex items-center justify-between p-3 rounded-lg border">
                      <div>
                        <Label>{t('widgetsPage.dialogs.form.status', 'Status')}</Label>
                        <p className="text-sm text-muted-foreground">{t('widgetsPage.dialogs.form.statusDesc', 'Enable or disable this widget')}</p>
                      </div>
                      <Select
                        value={formData.status}
                        onValueChange={(value) => setFormData({ ...formData, status: value })}
                      >
                        <SelectTrigger className="w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">{t('widgetsPage.dialogs.form.active', 'Active')}</SelectItem>
                          <SelectItem value="paused">{t('widgetsPage.dialogs.form.paused', 'Paused')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </TabsContent>

                  <TabsContent value="branding" className="mt-0 space-y-4">
                    <div className="space-y-2">
                      <Label>{t('widgetsPage.dialogs.form.icon', 'Widget Icon')}</Label>
                      <div className="flex items-center gap-4">
                        <div 
                          className="h-16 w-16 rounded-lg border-2 border-dashed flex items-center justify-center overflow-hidden cursor-pointer hover:border-primary transition-colors"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          {formData.iconPreview ? (
                            <img src={formData.iconPreview} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <Upload className="h-6 w-6 text-muted-foreground" />
                          )}
                        </div>
                        <div className="flex-1">
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            onChange={handleIconUpload}
                            className="hidden"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => fileInputRef.current?.click()}
                          >
                            {t('widgetsPage.dialogs.form.uploadIcon', 'Upload Icon')}
                          </Button>
                          {formData.iconPreview && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={removeIcon}
                              className="ml-2 text-destructive"
                            >
                              {t('widgetsPage.dialogs.form.remove', 'Remove')}
                            </Button>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">
                            {t('widgetsPage.dialogs.form.iconHelp', 'PNG, JPG up to 2MB. Recommended: 128x128px')}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="brandName">{t('widgetsPage.dialogs.form.brandName', 'Brand Name')}</Label>
                      <Input
                        id="brandName"
                        value={formData.brandName}
                        onChange={(e) => setFormData({ ...formData, brandName: e.target.value })}
                        placeholder={t('widgetsPage.dialogs.form.brandPlaceholder', 'Your Company')}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="buttonLabel">{t('widgetsPage.dialogs.form.buttonLabel', 'Button Label')}</Label>
                      <Input
                        id="buttonLabel"
                        value={formData.buttonLabel}
                        onChange={(e) => setFormData({ ...formData, buttonLabel: e.target.value })}
                        placeholder={t('widgetsPage.preview.voiceChat', 'VOICE CHAT')}
                        maxLength={20}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('widgetsPage.dialogs.form.buttonLabelHelp', 'Text displayed on the call button (max 20 characters)')}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>{t('widgetsPage.dialogs.form.primaryColor', 'Primary Color')}</Label>
                      <div className="flex flex-wrap gap-2 mb-2">
                        {COLOR_PRESETS.map((preset) => (
                          <button
                            key={preset.name}
                            type="button"
                            onClick={() => setFormData({ ...formData, primaryColor: preset.primary })}
                            className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${
                              formData.primaryColor === preset.primary ? 'ring-2 ring-offset-2 ring-primary' : ''
                            }`}
                            style={{ backgroundColor: preset.primary }}
                            title={preset.name}
                          />
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <Input
                          type="color"
                          value={formData.primaryColor}
                          onChange={(e) => setFormData({ ...formData, primaryColor: e.target.value })}
                          className="w-12 h-9 p-1"
                        />
                        <Input
                          value={formData.primaryColor}
                          onChange={(e) => setFormData({ ...formData, primaryColor: e.target.value })}
                          placeholder="#3B82F6"
                          className="flex-1"
                        />
                      </div>
                    </div>

                    <Separator />

                    <div className="flex items-center justify-between p-3 rounded-lg border">
                      <div>
                        <Label>{t('widgetsPage.dialogs.form.termsAcceptance', 'Require Terms Acceptance')}</Label>
                        <p className="text-sm text-muted-foreground">
                          {t('widgetsPage.dialogs.form.termsAcceptanceDesc', 'Show terms checkbox before starting call')}
                        </p>
                      </div>
                      <Switch
                        checked={formData.requireTermsAcceptance}
                        onCheckedChange={(checked) => setFormData({ ...formData, requireTermsAcceptance: checked })}
                      />
                    </div>

                    <div className="flex items-center justify-between p-3 rounded-lg border">
                      <div>
                        <Label>{t('widgetsPage.dialogs.form.appointmentBooking', 'Appointment Booking')}</Label>
                        <p className="text-sm text-muted-foreground">
                          {t('widgetsPage.dialogs.form.appointmentBookingDesc', 'Allow visitors to book appointments during calls')}
                        </p>
                      </div>
                      <Switch
                        checked={formData.appointmentBookingEnabled}
                        onCheckedChange={(checked) => setFormData({ ...formData, appointmentBookingEnabled: checked })}
                        data-testid="switch-appointment-booking"
                      />
                    </div>
                  </TabsContent>

                  <TabsContent value="settings" className="mt-0 space-y-4">
                    <div className="space-y-2">
                      <Label>{t('widgetsPage.dialogs.form.allowedDomains', 'Allowed Domains')}</Label>
                      <p className="text-sm text-muted-foreground">
                        {t('widgetsPage.dialogs.form.allowedDomainsDesc', 'Restrict where the widget can be embedded (leave empty for any domain)')}
                      </p>
                      <div className="flex gap-2">
                        <Input
                          value={domainInput}
                          onChange={(e) => setDomainInput(e.target.value)}
                          placeholder={t('widgetsPage.dialogs.form.domainPlaceholder', 'example.com')}
                          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addDomain())}
                        />
                        <Button type="button" onClick={addDomain} variant="secondary">
                          {t('widgetsPage.dialogs.form.add', 'Add')}
                        </Button>
                      </div>
                      {formData.allowedDomains.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-2">
                          {formData.allowedDomains.map((domain) => (
                            <Badge key={domain} variant="secondary" className="pr-1">
                              {domain}
                              <button
                                type="button"
                                onClick={() => removeDomain(domain)}
                                className="ml-2 hover:text-destructive"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>

                    <Separator />

                    <div className="flex items-center justify-between p-3 rounded-lg border">
                      <div>
                        <Label>{t('widgetsPage.dialogs.form.businessHours', 'Business Hours')}</Label>
                        <p className="text-sm text-muted-foreground">
                          {t('widgetsPage.dialogs.form.businessHoursDesc', 'Restrict availability to specific hours')}
                        </p>
                      </div>
                      <Switch
                        checked={formData.businessHoursEnabled}
                        onCheckedChange={(checked) => setFormData({ ...formData, businessHoursEnabled: checked })}
                      />
                    </div>

                    {formData.businessHoursEnabled && (
                      <div className="space-y-4 pl-4 border-l-2 border-muted">
                        <div className="space-y-2">
                          <Label>{t('widgetsPage.dialogs.form.timezone', 'Timezone')}</Label>
                          <Select
                            value={formData.businessTimezone}
                            onValueChange={(value) => setFormData({ ...formData, businessTimezone: value })}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {TIMEZONE_OPTIONS.map((tz) => (
                                <SelectItem key={tz.value} value={tz.value}>
                                  {tz.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>{t('widgetsPage.dialogs.form.startTime', 'Start Time')}</Label>
                            <Input
                              type="time"
                              value={formData.businessHoursStart}
                              onChange={(e) => setFormData({ ...formData, businessHoursStart: e.target.value })}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>{t('widgetsPage.dialogs.form.endTime', 'End Time')}</Label>
                            <Input
                              type="time"
                              value={formData.businessHoursEnd}
                              onChange={(e) => setFormData({ ...formData, businessHoursEnd: e.target.value })}
                            />
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label>{t('widgetsPage.dialogs.form.days', 'Days')}</Label>
                          <div className="flex flex-wrap gap-2">
                            {DAY_OPTIONS.map((day) => (
                              <button
                                key={day.value}
                                type="button"
                                onClick={() => toggleDay(day.value)}
                                className={`px-3 py-1.5 rounded-md border text-sm transition-colors ${
                                  formData.businessDays.includes(day.value)
                                    ? "bg-primary text-primary-foreground border-primary"
                                    : "bg-background hover-elevate"
                                }`}
                              >
                                {day.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                      <CollapsibleTrigger asChild>
                        <Button variant="ghost" className="w-full justify-between">
                          {t('widgetsPage.dialogs.form.advanced', 'Advanced Settings')}
                          <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-4 pt-4">
                        <div className="grid grid-cols-3 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="maxDuration">{t('widgetsPage.dialogs.form.maxDuration', 'Max Duration (sec)')}</Label>
                            <Input
                              id="maxDuration"
                              type="number"
                              min={10}
                              max={3600}
                              value={formData.maxCallDuration}
                              onChange={(e) => setFormData({ ...formData, maxCallDuration: parseInt(e.target.value) || 300 })}
                              data-testid="input-max-duration"
                            />
                            <p className="text-xs text-muted-foreground">{t('widgetsPage.dialogs.form.maxDurationHelp', '10-3600 seconds')}</p>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="cooldown">{t('widgetsPage.dialogs.form.cooldown', 'Cooldown (min)')}</Label>
                            <Input
                              id="cooldown"
                              type="number"
                              min={0}
                              max={60}
                              value={formData.cooldownMinutes}
                              onChange={(e) => setFormData({ ...formData, cooldownMinutes: parseInt(e.target.value) || 0 })}
                              data-testid="input-cooldown"
                            />
                            <p className="text-xs text-muted-foreground">{t('widgetsPage.dialogs.form.cooldownHelp', 'Wait time per IP')}</p>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="maxConcurrent">{t('widgetsPage.dialogs.form.maxSessions', 'Max Sessions')}</Label>
                            <Input
                              id="maxConcurrent"
                              type="number"
                              min={1}
                              max={100}
                              value={formData.maxConcurrentCalls}
                              onChange={(e) => setFormData({ ...formData, maxConcurrentCalls: parseInt(e.target.value) || 5 })}
                              data-testid="input-max-concurrent"
                            />
                            <p className="text-xs text-muted-foreground">{t('widgetsPage.dialogs.form.maxSessionsHelp', '1-100 sessions')}</p>
                          </div>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </TabsContent>
                  </div>
                </ScrollArea>
              </Tabs>
            </div>

            <div className="hidden lg:block lg:w-[440px] shrink-0 lg:border-l lg:pl-6">
              <h3 className="font-semibold mb-3">{t('widgetsPage.dialogs.preview', 'Preview')}</h3>
              <div className="max-h-[400px] lg:max-h-none overflow-auto">
                <InteractiveWidgetPreview formData={formData} appName={appName} />
              </div>
            </div>
          </div>

          <DialogFooter className="mt-4 flex-col-reverse sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setIsCreateOpen(false);
                setEditingWidget(null);
                resetForm();
              }}
            >
              {t('widgetsPage.dialogs.cancel', 'Cancel')}
            </Button>
            <Button onClick={handleSubmit} disabled={isSubmitting} data-testid="button-save-widget">
              {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingWidget ? t('widgetsPage.dialogs.saveChanges', 'Save Changes') : t('widgetsPage.createWidget', 'Create Widget')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={embedCodeWidget !== null} onOpenChange={(open) => !open && setEmbedCodeWidget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('widgetsPage.dialogs.embedTitle', 'Embed Code')}</DialogTitle>
            <DialogDescription>
              {t('widgetsPage.dialogs.embedDesc', "Copy this code and paste it into your website's HTML, just before the closing </body> tag.")}
            </DialogDescription>
          </DialogHeader>
          
          <div className="relative mt-4">
            <ScrollArea className="h-48">
              <pre className="bg-muted p-4 rounded-lg text-xs font-mono whitespace-pre-wrap break-all">
                {embedCode}
              </pre>
            </ScrollArea>
            <Button
              size="sm"
              className="absolute top-2 right-4"
              onClick={() => copyToClipboard(embedCode)}
            >
              <Copy className="h-4 w-4 mr-1" />
              {t('widgetsPage.dialogs.copy', 'Copy')}
            </Button>
          </div>

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setEmbedCodeWidget(null)}>
              {t('widgetsPage.dialogs.close', 'Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
