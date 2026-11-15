/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 * Copyright (c) Titan Zero.
 * ============================================================
 */
import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { Plus, Phone, Trash2, Link as LinkIcon, PhoneIncoming, Bot, ArrowRight, Mic } from "lucide-react";
import { SiOpenai, SiTwilio } from "react-icons/si";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";





import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePluginStatus } from "@/hooks/use-plugin-status";
import { ElevenLabsIcon } from "@/pages/incoming-connections/ElevenLabsIcon";
import { ElevenLabsDialogs } from "@/pages/incoming-connections/ElevenLabsDialogs";
import { PlivoDialogs } from "@/pages/incoming-connections/PlivoDialogs";
import { TwilioOpenaiDialogs } from "@/pages/incoming-connections/TwilioOpenaiDialogs";
import { CustomVoiceDialogs } from "@/pages/incoming-connections/CustomVoiceDialogs";
import type { IncomingConnection, Agent, IncomingConnectionsResponse, PlivoIncomingConnectionsResponse, PlivoConnection, TwilioOpenaiConnection, TwilioOpenaiIncomingConnectionsResponse, EngineTab, VoiceEngineSettings } from "@/pages/incoming-connections/types";

// ElevenLabs icon SVG component

export default function IncomingConnectionsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<EngineTab>('twilio-elevenlabs');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteConnection, setDeleteConnection] = useState<IncomingConnection | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedPhoneId, setSelectedPhoneId] = useState("");

  // Plivo state
  const [plivoCreateDialogOpen, setPlivoCreateDialogOpen] = useState(false);
  const [plivoDeleteConnection, setPlivoDeleteConnection] = useState<PlivoConnection | null>(null);
  const [selectedPlivoAgentId, setSelectedPlivoAgentId] = useState("");
  const [selectedPlivoPhoneId, setSelectedPlivoPhoneId] = useState("");

  // Twilio + OpenAI state
  const [twilioOpenaiCreateDialogOpen, setTwilioOpenaiCreateDialogOpen] = useState(false);
  const [twilioOpenaiDeleteConnection, setTwilioOpenaiDeleteConnection] = useState<TwilioOpenaiConnection | null>(null);
  const [selectedTwilioOpenaiAgentId, setSelectedTwilioOpenaiAgentId] = useState("");
  const [selectedTwilioOpenaiPhoneId, setSelectedTwilioOpenaiPhoneId] = useState("");

  const { isCustomVoiceEngineEnabled } = usePluginStatus();
  
  // Custom Voice Engine state
  const [cveCreateDialogOpen, setCveCreateDialogOpen] = useState(false);
  const [cveDeleteConnection, setCveDeleteConnection] = useState<IncomingConnection | null>(null);
  const [selectedCveAgentId, setSelectedCveAgentId] = useState("");
  const [selectedCvePhoneId, setSelectedCvePhoneId] = useState("");

  const { data, isLoading: connectionsLoading } = useQuery<IncomingConnectionsResponse>({
    queryKey: ["/api/incoming-connections"],
  });

  // Plivo incoming connections query
  const { data: plivoData, isLoading: plivoConnectionsLoading } = useQuery<PlivoIncomingConnectionsResponse>({
    queryKey: ["/api/plivo/incoming-connections"],
  });

  // Twilio + OpenAI incoming connections query
  const { data: twilioOpenaiData, isLoading: twilioOpenaiConnectionsLoading } = useQuery<TwilioOpenaiIncomingConnectionsResponse>({
    queryKey: ["/api/twilio-openai/incoming-connections"],
  });

  // Voice engine settings to determine which engines are enabled
  const { data: voiceEngineSettings } = useQuery<VoiceEngineSettings>({
    queryKey: ["/api/settings/voice-engine"],
  });
  const plivoEnabled = voiceEngineSettings?.plivo_openai_engine_enabled ?? false;
  const twilioOpenaiEnabled = voiceEngineSettings?.twilio_openai_engine_enabled ?? false;

  // Current user (for plan type detection)
  const { data: currentUser } = useQuery<{ planType: string }>({
    queryKey: ["/api/auth/me"],
  });
  const isFreePlan = currentUser?.planType === 'free';

  // Calculate enabled engines for tab columns
  const enabledEngineCount = useMemo(() => {
    let count = 1; // Twilio + ElevenLabs is always enabled
    if (isCustomVoiceEngineEnabled) count++;
    if (plivoEnabled) count++;
    if (twilioOpenaiEnabled) count++;
    return count;
  }, [isCustomVoiceEngineEnabled, plivoEnabled, twilioOpenaiEnabled]);

  // Reset activeTab to always-enabled engine if current tab becomes disabled
  useEffect(() => {
    if (activeTab === 'plivo-openai' && !plivoEnabled) {
      setActiveTab('twilio-elevenlabs');
    }
    if (activeTab === 'twilio-openai' && !twilioOpenaiEnabled) {
      setActiveTab('twilio-elevenlabs');
    }
  }, [activeTab, plivoEnabled, twilioOpenaiEnabled]);

  // Filter connections and agents by provider
  const rawConnections = data?.connections || [];
  const rawAgents = data?.incomingAgents || [];

  const connections = rawConnections.filter(c => c.agent?.telephonyProvider !== 'custom-voice-engine');
  const cveConnections = rawConnections.filter(c => c.agent?.telephonyProvider === 'custom-voice-engine');

  const availablePhoneNumbers = data?.availablePhoneNumbers || [];

  const agents = rawAgents.filter(a => a.telephonyProvider !== 'custom-voice-engine');
  const cveAgents = rawAgents.filter(a => a.telephonyProvider === 'custom-voice-engine');

  const createMutation = useMutation({
    mutationFn: async (data: { agentId: string; phoneNumberId: string }) => {
      return apiRequest("POST", "/api/incoming-connections", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/incoming-connections"] });
      toast({
        title: t("incomingConnections.toast.created"),
        description: t("incomingConnections.toast.createdDesc"),
      });
      setCreateDialogOpen(false);
      setSelectedAgentId("");
      setSelectedPhoneId("");
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: t("incomingConnections.toast.createFailed"),
        description: error.message || t("incomingConnections.toast.createFailedDesc"),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/incoming-connections/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/incoming-connections"] });
      toast({
        title: t("incomingConnections.toast.deleted"),
        description: t("incomingConnections.toast.deletedDesc"),
      });
      setDeleteConnection(null);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: t("incomingConnections.toast.deleteFailed"),
        description: error.message || t("incomingConnections.toast.deleteFailedDesc"),
      });
    },
  });

  // Custom Voice Engine creation mutation
  const cveCreateMutation = useMutation({
    mutationFn: async (data: { agentId: string; phoneNumberId: string }) => {
      return apiRequest("POST", "/api/incoming-connections", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/incoming-connections"] });
      toast({
        title: "Connection Created",
        description: "Custom Voice incoming connection has been created successfully.",
      });
      setCveCreateDialogOpen(false);
      setSelectedCveAgentId("");
      setSelectedCvePhoneId("");
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to Create Connection",
        description: error.message || "Could not create the incoming connection.",
      });
    },
  });

  const cveDeleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/incoming-connections/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/incoming-connections"] });
      toast({
        title: "Connection Removed",
        description: "Custom Voice connection has been removed successfully.",
      });
      setCveDeleteConnection(null);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to Remove Connection",
        description: error.message || "Could not remove the incoming connection.",
      });
    },
  });

  const handleCveCreate = () => {
    if (!selectedCveAgentId || !selectedCvePhoneId) {
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Please select both an agent and a phone number.",
      });
      return;
    }
    cveCreateMutation.mutate({
      agentId: selectedCveAgentId,
      phoneNumberId: selectedCvePhoneId,
    });
  };

  // Plivo mutations
  const plivoConnections = plivoData?.connections || [];
  const plivoAvailablePhoneNumbers = plivoData?.availablePhoneNumbers || [];
  const plivoAvailableAgents = plivoData?.availableAgents || [];
  const plivoStats = {
    totalConnections: plivoData?.stats?.totalConnections || 0,
    availableNumbers: plivoData?.stats?.availableNumbers || 0,
    totalAgents: plivoData?.stats?.totalAgents || 0,
  };

  // Merge Twilio + Plivo numbers for Custom Voice selection
  const allAvailableNumbersForCve = useMemo(() => {
    return [
      ...availablePhoneNumbers.map(p => ({ ...p, provider: 'twilio' })),
      ...plivoAvailablePhoneNumbers.map(p => ({ ...p, provider: 'plivo' }))
    ];
  }, [availablePhoneNumbers, plivoAvailablePhoneNumbers]);

  const plivoCreateMutation = useMutation({
    mutationFn: async (data: { agentId: string; phoneNumberId: string }) => {
      return apiRequest("POST", "/api/plivo/incoming-connections", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/incoming-connections"] });
      toast({
        title: "Connection Created",
        description: "Plivo incoming connection has been created successfully.",
      });
      setPlivoCreateDialogOpen(false);
      setSelectedPlivoAgentId("");
      setSelectedPlivoPhoneId("");
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to Create Connection",
        description: error.message || "Could not create the incoming connection.",
      });
    },
  });

  const plivoDeleteMutation = useMutation({
    mutationFn: async (phoneNumberId: string) => {
      return apiRequest("DELETE", `/api/plivo/incoming-connections/${phoneNumberId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/incoming-connections"] });
      toast({
        title: "Connection Removed",
        description: "Plivo incoming connection has been removed successfully.",
      });
      setPlivoDeleteConnection(null);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to Remove Connection",
        description: error.message || "Could not remove the incoming connection.",
      });
    },
  });

  const handlePlivoCreate = () => {
    if (!selectedPlivoAgentId || !selectedPlivoPhoneId) {
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Please select both an agent and a phone number.",
      });
      return;
    }
    plivoCreateMutation.mutate({
      agentId: selectedPlivoAgentId,
      phoneNumberId: selectedPlivoPhoneId,
    });
  };

  // Twilio + OpenAI data extraction
  const twilioOpenaiConnections = twilioOpenaiData?.connections || [];
  const twilioOpenaiAvailablePhoneNumbers = twilioOpenaiData?.availablePhoneNumbers || [];
  const twilioOpenaiAvailableAgents = twilioOpenaiData?.availableAgents || [];
  const twilioOpenaiStats = {
    totalConnections: twilioOpenaiData?.stats?.totalConnections || 0,
    availableNumbers: twilioOpenaiData?.stats?.availableNumbers || 0,
    totalAgents: twilioOpenaiData?.stats?.totalAgents || 0,
  };

  const twilioOpenaiCreateMutation = useMutation({
    mutationFn: async (data: { agentId: string; phoneNumberId: string }) => {
      return apiRequest("POST", "/api/twilio-openai/incoming-connections", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/twilio-openai/incoming-connections"] });
      toast({
        title: "Connection Created",
        description: "Twilio + OpenAI incoming connection has been created successfully.",
      });
      setTwilioOpenaiCreateDialogOpen(false);
      setSelectedTwilioOpenaiAgentId("");
      setSelectedTwilioOpenaiPhoneId("");
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to Create Connection",
        description: error.message || "Could not create the incoming connection.",
      });
    },
  });

  const twilioOpenaiDeleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/twilio-openai/incoming-connections/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/twilio-openai/incoming-connections"] });
      toast({
        title: "Connection Removed",
        description: "Twilio + OpenAI incoming connection has been removed successfully.",
      });
      setTwilioOpenaiDeleteConnection(null);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to Remove Connection",
        description: error.message || "Could not remove the incoming connection.",
      });
    },
  });

  const handleTwilioOpenaiCreate = () => {
    if (!selectedTwilioOpenaiAgentId || !selectedTwilioOpenaiPhoneId) {
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Please select both an agent and a phone number.",
      });
      return;
    }
    twilioOpenaiCreateMutation.mutate({
      agentId: selectedTwilioOpenaiAgentId,
      phoneNumberId: selectedTwilioOpenaiPhoneId,
    });
  };

  const handleCreate = () => {
    if (!selectedAgentId || !selectedPhoneId) {
      toast({
        variant: "destructive",
        title: t("incomingConnections.toast.validationError"),
        description: t("incomingConnections.toast.validationErrorDesc"),
      });
      return;
    }

    createMutation.mutate({
      agentId: selectedAgentId,
      phoneNumberId: selectedPhoneId,
    });
  };

  // Get current tab's create dialog handler
  const handleNewConnection = () => {
    switch (activeTab) {
      case 'twilio-elevenlabs':
        setCreateDialogOpen(true);
        break;
      case 'plivo-openai':
        setPlivoCreateDialogOpen(true);
        break;
      case 'twilio-openai':
        setTwilioOpenaiCreateDialogOpen(true);
        break;
      case 'custom-voice':
        setCveCreateDialogOpen(true);
        break;
    }
  };

  // Calculate total stats
  const totalConnections = connections.length + plivoStats.totalConnections + twilioOpenaiStats.totalConnections;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-50 via-gray-50 to-zinc-50 dark:from-slate-950/40 dark:via-gray-900/30 dark:to-zinc-950/40 border p-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-slate-600 to-gray-700 flex items-center justify-center shadow-lg">
              <PhoneIncoming className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground" data-testid="heading-incoming-connections">
                {t("incomingConnections.title")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("incomingConnections.subtitle")}
              </p>
            </div>
          </div>
          <Button onClick={handleNewConnection} data-testid="button-create-connection">
            <Plus className="w-4 h-4 mr-2" />
           { t("incomingConnections.newconnection" , 'New Connection ')}
          </Button>
        </div>

        {/* Engine Summary Cards */}
        <div className={`mt-6 grid grid-cols-1 gap-4 ${
          enabledEngineCount === 1 ? 'md:grid-cols-1' : 
          enabledEngineCount === 2 ? 'md:grid-cols-2' : 
          enabledEngineCount === 3 ? 'md:grid-cols-3' : 
          'md:grid-cols-4'
        }`}>
          {/* Twilio + ElevenLabs Summary - Always shown */}
          <div 
            className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
              activeTab === 'twilio-elevenlabs' 
                ? 'border-violet-500 bg-violet-500/10 dark:bg-violet-500/20' 
                : 'border-border bg-background/50 hover:border-violet-300'
            }`}
            onClick={() => setActiveTab('twilio-elevenlabs')}
            data-testid="engine-card-twilio-elevenlabs"
          >
            <div className="flex items-center gap-2 mb-2">
              <SiTwilio className="h-4 w-4 text-red-500" />
              <span className="font-medium text-sm">+</span>
              <ElevenLabsIcon className="h-4 w-4 text-violet-600" />
              <span className="font-semibold text-sm">Twilio + ElevenLabs</span>
            </div>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span><strong className="text-violet-600">{connections.length}</strong> active</span>
              <span><strong>{availablePhoneNumbers.length}</strong> available</span>
              <span><strong>{agents.length}</strong> agents</span>
            </div>
          </div>

          {/* Custom Voice Engine Summary - Only shown when enabled */}
          {isCustomVoiceEngineEnabled && (
            <div 
              className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                activeTab === 'custom-voice' 
                  ? 'border-indigo-500 bg-indigo-500/10 dark:bg-indigo-500/20' 
                  : 'border-border bg-background/50 hover:border-indigo-300'
              }`}
              onClick={() => setActiveTab('custom-voice')}
              data-testid="engine-card-custom-voice"
            >
              <div className="flex items-center gap-2 mb-2">
                <Mic className="h-4 w-4 text-indigo-600" />
                <span className="font-semibold text-sm">Custom Voice</span>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span><strong className="text-indigo-600">{cveConnections.length}</strong> active</span>
                <span><strong>{allAvailableNumbersForCve.length}</strong> available</span>
                <span><strong>{cveAgents.length}</strong> agents</span>
              </div>
            </div>
          )}

          {/* Plivo + OpenAI Summary - Only shown when enabled */}
          {plivoEnabled && (
            <div 
              className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                activeTab === 'plivo-openai' 
                  ? 'border-emerald-500 bg-emerald-500/10 dark:bg-emerald-500/20' 
                  : 'border-border bg-background/50 hover:border-emerald-300'
              }`}
              onClick={() => setActiveTab('plivo-openai')}
              data-testid="engine-card-plivo-openai"
            >
              <div className="flex items-center gap-2 mb-2">
                <Phone className="h-4 w-4 text-green-600" />
                <span className="font-medium text-sm">+</span>
                <SiOpenai className="h-4 w-4 text-emerald-600" />
                <span className="font-semibold text-sm">Plivo + OpenAI</span>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span><strong className="text-emerald-600">{plivoStats.totalConnections}</strong> active</span>
                <span><strong>{plivoStats.availableNumbers}</strong> available</span>
                <span><strong>{plivoStats.totalAgents}</strong> agents</span>
              </div>
            </div>
          )}

          {/* Twilio + OpenAI Summary - Only shown when enabled */}
          {twilioOpenaiEnabled && (
            <div 
              className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                activeTab === 'twilio-openai' 
                  ? 'border-brand bg-brand/10 dark:bg-brand/20' 
                  : 'border-border bg-background/50 hover:border-brand/30'
              }`}
              onClick={() => setActiveTab('twilio-openai')}
              data-testid="engine-card-twilio-openai"
            >
              <div className="flex items-center gap-2 mb-2">
                <SiTwilio className="h-4 w-4 text-red-500" />
                <span className="font-medium text-sm">+</span>
                <SiOpenai className="h-4 w-4 text-brand" />
                <span className="font-semibold text-sm">Twilio + OpenAI</span>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span><strong className="text-brand">{twilioOpenaiStats.totalConnections}</strong> active</span>
                <span><strong>{twilioOpenaiStats.availableNumbers}</strong> available</span>
                <span><strong>{twilioOpenaiStats.totalAgents}</strong> agents</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Tabbed Content */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as EngineTab)} className="w-full">
        <TabsList className={`grid w-full mb-4 ${
          enabledEngineCount === 1 ? 'grid-cols-1' : 
          enabledEngineCount === 2 ? 'grid-cols-2' : 
          enabledEngineCount === 3 ? 'grid-cols-3' : 
          'grid-cols-4'
        }`}>
          <TabsTrigger value="twilio-elevenlabs" className="flex items-center gap-2" data-testid="tab-twilio-elevenlabs">
            <SiTwilio className="h-3.5 w-3.5 text-red-500" />
            <ElevenLabsIcon className="h-3.5 w-3.5 text-violet-600" />
            <span className="hidden sm:inline">Twilio + ElevenLabs</span>
          </TabsTrigger>
          {isCustomVoiceEngineEnabled && (
            <TabsTrigger value="custom-voice" className="flex items-center gap-2" data-testid="tab-custom-voice">
              <Mic className="h-3.5 w-3.5 text-indigo-600" />
              <span className="hidden sm:inline">Custom Voice</span>
            </TabsTrigger>
          )}
          {plivoEnabled && (
            <TabsTrigger value="plivo-openai" className="flex items-center gap-2" data-testid="tab-plivo-openai">
              <Phone className="h-3.5 w-3.5 text-green-600" />
              <SiOpenai className="h-3.5 w-3.5 text-emerald-600" />
              <span className="hidden sm:inline">Plivo + OpenAI</span>
            </TabsTrigger>
          )}
          {twilioOpenaiEnabled && (
            <TabsTrigger value="twilio-openai" className="flex items-center gap-2" data-testid="tab-twilio-openai">
              <SiTwilio className="h-3.5 w-3.5 text-red-500" />
              <SiOpenai className="h-3.5 w-3.5 text-brand" />
              <span className="hidden sm:inline">Twilio + OpenAI</span>
            </TabsTrigger>
          )}
        </TabsList>

        {/* Twilio + ElevenLabs Content */}
        <TabsContent value="twilio-elevenlabs">
          <Card>
            <CardContent className="pt-6">
              {connectionsLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />
                  ))}
                </div>
              ) : connections.length === 0 ? (
                <div className="text-center py-12" data-testid="empty-state">
                  <LinkIcon className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">{t("incomingConnections.empty.title")}</h3>
                  <p className="text-sm text-muted-foreground mb-6">
                    {t("incomingConnections.empty.description")}
                  </p>
                  <Button 
                    onClick={() => setCreateDialogOpen(true)}
                    disabled={availablePhoneNumbers.length === 0 || agents.length === 0}
                    className="bg-violet-600 hover:bg-violet-700"
                    data-testid="button-create-first-connection"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    {t("incomingConnections.empty.createFirst")}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {connections.map((connection) => (
                    <div
                      key={connection.id}
                      className="flex items-center justify-between p-4 border rounded-lg hover-elevate bg-card"
                      data-testid={`connection-card-${connection.id}`}
                    >
                      <div className="flex items-center gap-4">
                        <Badge variant="secondary" className="font-mono text-xs bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                          {connection.phoneNumber.phoneNumber}
                        </Badge>
                        <ArrowRight className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <div className="flex items-center gap-2">
                            <ElevenLabsIcon className="h-4 w-4 text-violet-600" />
                            <span className="font-medium">{connection.agent.name}</span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {connection.phoneNumber.friendlyName && `${connection.phoneNumber.friendlyName} • `}
                            Language: {connection.agent.language || 'en'}
                          </div>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteConnection(connection)}
                        data-testid={`button-delete-${connection.id}`}
                      >
                        <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Custom Voice Content */}
        {isCustomVoiceEngineEnabled && (
        <TabsContent value="custom-voice">
          <Card>
            <CardContent className="pt-6">
              {connectionsLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />
                  ))}
                </div>
              ) : cveConnections.length === 0 ? (
                <div className="text-center py-12" data-testid="cve-empty-state">
                  <LinkIcon className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No Custom Voice Connections Yet</h3>
                  <p className="text-sm text-muted-foreground mb-6">
                    Connect any phone number to a Custom Voice Engine agent.
                  </p>
                  <Button 
                    onClick={() => setCveCreateDialogOpen(true)}
                    disabled={allAvailableNumbersForCve.length === 0 || cveAgents.length === 0}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Create First Connection
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {cveConnections.map((connection) => (
                    <div
                      key={connection.id}
                      className="flex items-center justify-between p-4 border rounded-lg hover-elevate bg-card"
                    >
                      <div className="flex items-center gap-4">
                        <Badge variant="secondary" className="font-mono text-xs bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                          {connection.phoneNumber.phoneNumber}
                        </Badge>
                        <ArrowRight className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <div className="flex items-center gap-2">
                            <Mic className="h-4 w-4 text-indigo-600" />
                            <span className="font-medium">{connection.agent.name}</span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {connection.phoneNumber.friendlyName && `${connection.phoneNumber.friendlyName} • `}
                            Language: {connection.agent.language || 'en'}
                          </div>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setCveDeleteConnection(connection)}
                      >
                        <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>)}

        {/* Plivo + OpenAI Content */}
        {plivoEnabled && (
        <TabsContent value="plivo-openai">
          <Card>
            <CardContent className="pt-6">
              {plivoConnectionsLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />
                  ))}
                </div>
              ) : plivoConnections.length === 0 && plivoAvailablePhoneNumbers.length === 0 ? (
                <div className="text-center py-12" data-testid="plivo-empty-state">
                  <Bot className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No Plivo Phone Numbers</h3>
                  <p className="text-sm text-muted-foreground mb-6">
                    Purchase Plivo phone numbers first to set up incoming connections with OpenAI agents.
                  </p>
                </div>
              ) : plivoConnections.length === 0 ? (
                <div className="text-center py-12" data-testid="plivo-no-connections">
                  <LinkIcon className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No Connections Yet</h3>
                  <p className="text-sm text-muted-foreground mb-6">
                    Connect your Plivo phone numbers to OpenAI-powered agents.
                  </p>
                  <Button 
                    onClick={() => setPlivoCreateDialogOpen(true)}
                    disabled={plivoAvailablePhoneNumbers.length === 0 || plivoAvailableAgents.length === 0}
                    className="bg-emerald-600 hover:bg-emerald-700"
                    data-testid="button-create-first-plivo-connection"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Create First Connection
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {plivoConnections.map((connection) => (
                    <div
                      key={connection.phoneNumberId}
                      className="flex items-center justify-between p-4 border rounded-lg hover-elevate bg-card"
                      data-testid={`plivo-connection-card-${connection.phoneNumberId}`}
                    >
                      <div className="flex items-center gap-4">
                        <Badge variant="secondary" className="font-mono text-xs bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                          {connection.phoneNumber}
                        </Badge>
                        <ArrowRight className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <div className="flex items-center gap-2">
                            <SiOpenai className="h-4 w-4 text-emerald-600" />
                            <span className="font-medium">{connection.agent?.name || 'Unknown Agent'}</span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {connection.friendlyName && `${connection.friendlyName} • `}
                            Country: {connection.country}
                          </div>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setPlivoDeleteConnection(connection)}
                        data-testid={`button-delete-plivo-${connection.phoneNumberId}`}
                      >
                        <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>)}

        {/* Twilio + OpenAI Content */}
        {twilioOpenaiEnabled && (
        <TabsContent value="twilio-openai">
          <Card>
            <CardContent className="pt-6">
              {twilioOpenaiConnectionsLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />
                  ))}
                </div>
              ) : twilioOpenaiConnections.length === 0 && twilioOpenaiAvailablePhoneNumbers.length === 0 ? (
                <div className="text-center py-12" data-testid="twilio-openai-empty-state">
                  <Bot className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No Twilio Phone Numbers</h3>
                  <p className="text-sm text-muted-foreground mb-6">
                    Purchase Twilio phone numbers first to set up incoming connections with OpenAI agents.
                  </p>
                </div>
              ) : twilioOpenaiConnections.length === 0 ? (
                <div className="text-center py-12" data-testid="twilio-openai-no-connections">
                  <LinkIcon className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No Connections Yet</h3>
                  <p className="text-sm text-muted-foreground mb-6">
                    Connect your Twilio phone numbers to OpenAI-powered agents.
                  </p>
                  <Button 
                    onClick={() => setTwilioOpenaiCreateDialogOpen(true)}
                    disabled={twilioOpenaiAvailablePhoneNumbers.length === 0 || twilioOpenaiAvailableAgents.length === 0}
                    className="bg-brand text-brand-foreground"
                    data-testid="button-create-first-twilio-openai-connection"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Create First Connection
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {twilioOpenaiConnections.map((connection) => (
                    <div
                      key={connection.id}
                      className="flex items-center justify-between p-4 border rounded-lg hover-elevate bg-card"
                      data-testid={`twilio-openai-connection-card-${connection.id}`}
                    >
                      <div className="flex items-center gap-4">
                        <Badge variant="secondary" className="font-mono text-xs bg-brand/10 text-brand dark:bg-brand/20 dark:text-brand">
                          {connection.phoneNumber?.phoneNumber || 'Unknown'}
                        </Badge>
                        <ArrowRight className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <div className="flex items-center gap-2">
                            <SiOpenai className="h-4 w-4 text-brand" />
                            <span className="font-medium">{connection.agent?.name || 'Unknown Agent'}</span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {connection.phoneNumber?.friendlyName && `${connection.phoneNumber.friendlyName} • `}
                            Country: {connection.phoneNumber?.country || 'N/A'}
                          </div>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setTwilioOpenaiDeleteConnection(connection)}
                        data-testid={`button-delete-twilio-openai-${connection.id}`}
                      >
                        <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>)}
      </Tabs>

      <ElevenLabsDialogs
        createDialogOpen={createDialogOpen}
        setCreateDialogOpen={setCreateDialogOpen}
        selectedAgentId={selectedAgentId}
        setSelectedAgentId={setSelectedAgentId}
        selectedPhoneId={selectedPhoneId}
        setSelectedPhoneId={setSelectedPhoneId}
        agents={agents}
        availablePhoneNumbers={availablePhoneNumbers}
        isFreePlan={isFreePlan}
        setLocation={setLocation}
        handleCreate={handleCreate}
        createMutation={createMutation}
        deleteConnection={deleteConnection}
        setDeleteConnection={setDeleteConnection}
        deleteMutation={deleteMutation}
      />
      <PlivoDialogs
        plivoCreateDialogOpen={plivoCreateDialogOpen}
        setPlivoCreateDialogOpen={setPlivoCreateDialogOpen}
        selectedPlivoAgentId={selectedPlivoAgentId}
        setSelectedPlivoAgentId={setSelectedPlivoAgentId}
        selectedPlivoPhoneId={selectedPlivoPhoneId}
        setSelectedPlivoPhoneId={setSelectedPlivoPhoneId}
        plivoAvailableAgents={plivoAvailableAgents}
        plivoAvailablePhoneNumbers={plivoAvailablePhoneNumbers}
        handlePlivoCreate={handlePlivoCreate}
        plivoCreateMutation={plivoCreateMutation}
        plivoDeleteConnection={plivoDeleteConnection}
        setPlivoDeleteConnection={setPlivoDeleteConnection}
        plivoDeleteMutation={plivoDeleteMutation}
      />
      <TwilioOpenaiDialogs
        twilioOpenaiCreateDialogOpen={twilioOpenaiCreateDialogOpen}
        setTwilioOpenaiCreateDialogOpen={setTwilioOpenaiCreateDialogOpen}
        selectedTwilioOpenaiAgentId={selectedTwilioOpenaiAgentId}
        setSelectedTwilioOpenaiAgentId={setSelectedTwilioOpenaiAgentId}
        selectedTwilioOpenaiPhoneId={selectedTwilioOpenaiPhoneId}
        setSelectedTwilioOpenaiPhoneId={setSelectedTwilioOpenaiPhoneId}
        twilioOpenaiAvailableAgents={twilioOpenaiAvailableAgents}
        twilioOpenaiAvailablePhoneNumbers={twilioOpenaiAvailablePhoneNumbers}
        handleTwilioOpenaiCreate={handleTwilioOpenaiCreate}
        twilioOpenaiCreateMutation={twilioOpenaiCreateMutation}
        twilioOpenaiDeleteConnection={twilioOpenaiDeleteConnection}
        setTwilioOpenaiDeleteConnection={setTwilioOpenaiDeleteConnection}
        twilioOpenaiDeleteMutation={twilioOpenaiDeleteMutation}
      />
      <CustomVoiceDialogs
        cveCreateDialogOpen={cveCreateDialogOpen}
        setCveCreateDialogOpen={setCveCreateDialogOpen}
        selectedCveAgentId={selectedCveAgentId}
        setSelectedCveAgentId={setSelectedCveAgentId}
        selectedCvePhoneId={selectedCvePhoneId}
        setSelectedCvePhoneId={setSelectedCvePhoneId}
        cveAgents={cveAgents}
        allAvailableNumbersForCve={allAvailableNumbersForCve}
        handleCveCreate={handleCveCreate}
        cveCreateMutation={cveCreateMutation}
        cveDeleteConnection={cveDeleteConnection}
        setCveDeleteConnection={setCveDeleteConnection}
        cveDeleteMutation={cveDeleteMutation}
      />
    </div>
  );
}
