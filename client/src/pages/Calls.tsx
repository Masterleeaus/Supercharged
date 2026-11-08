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
import { useState, useRef, useEffect } from "react";
import { useTranslation } from 'react-i18next';
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataPagination } from "@/components/ui/data-pagination";
import { Search, Download, Loader2, Phone, Calendar, Clock, MessageSquare, Eye, Play, Pause, Volume2, PhoneIncoming, PhoneOutgoing, CheckCircle2, XCircle, Mic, FileText, Sparkles, Globe, Video } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { format, formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { AuthStorage } from "@/lib/auth-storage";
import { formatSipEndpoint } from "@/lib/formatters";
import { useDemoMode } from "@/components/DemoModeBanner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

interface Call {
  id: string;
  contactId: string | null;
  campaignId: string | null;
  phoneNumber?: string | null;
  fromNumber?: string | null;
  toNumber?: string | null;
  status: string;
  duration: number | null;
  classification: string | null;
  sentiment: string | null;
  recordingUrl: string | null;
  transcript: string | null;
  aiSummary: string | null;
  metadata: Record<string, any> | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  callDirection: string | null;
  elevenLabsConversationId?: string | null;
  campaign?: { id: string; name: string } | null;
  contact?: { id: string; firstName: string; lastName?: string; phone: string } | null;
  incomingConnection?: { id: string; agentId: string } | null;
  engine?: 'elevenlabs' | 'twilio-openai' | 'plivo-openai' | 'openai' | 'custom-voice-engine';
  agent?: { id: string; name: string } | null;
  widgetId?: string | null;
  widget?: { id: string; name: string } | null;
}

export default function Calls() {
  const { t } = useTranslation();
  const { isDemoMode } = useDemoMode();
  const [isVideoOpen, setIsVideoOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sentimentFilter, setSentimentFilter] = useState("all");
  const [directionFilter, setDirectionFilter] = useState("all");
  const [leadFilter, setLeadFilter] = useState("all");
  const [playingCallId, setPlayingCallId] = useState<string | null>(null);
  const [loadingRecording, setLoadingRecording] = useState<string | null>(null);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentPlayingIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [activeTab, setActiveTab] = useState("all");

  // Reset page to 1 when filters or tab change
  useEffect(() => {
    setPage(1);
  }, [searchQuery, statusFilter, sentimentFilter, directionFilter, leadFilter, activeTab]);

  const { data: publicSettings } = useQuery<{ system_timezone?: string }>({
    queryKey: ["/api/settings/public"],
    queryFn: async () => {
      const res = await fetch("/api/settings/public");
      if (!res.ok) throw new Error("Failed to fetch public settings");
      return res.json();
    }
  });
  const systemTimezone = publicSettings?.system_timezone || "UTC";

  const formatCallDate = (dateString: string | null) => {
    if (!dateString) return "";
    try {
      const date = new Date(dateString);
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: systemTimezone,
        timeZoneName: 'short'
      }).format(date);
    } catch (e) {
      return dateString || "";
    }
  };

  const { data: paginatedData, isLoading } = useQuery<{
    data: Call[];
    pagination: {
      page: number;
      pageSize: number;
      totalItems: number;
      totalPages: number;
    };
    stats: {
      allCount: number;
      transcribedCount: number;
      recordingsCount: number;
      totalCalls: number;
      completedCalls: number;
      incomingCalls: number;
      outgoingCalls: number;
    };
  }>({
    queryKey: ["/api/calls", page, pageSize, searchQuery, statusFilter, sentimentFilter, directionFilter, leadFilter, activeTab],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
        tab: activeTab,
      });
      if (searchQuery) params.append("search", searchQuery);
      if (statusFilter !== "all") params.append("status", statusFilter);
      if (sentimentFilter !== "all") params.append("sentiment", sentimentFilter);
      if (directionFilter !== "all") params.append("direction", directionFilter);
      if (leadFilter !== "all") params.append("classification", leadFilter);

      const headers: Record<string, string> = {};
      const authHeader = AuthStorage.getAuthHeader();
      if (authHeader) {
        headers["Authorization"] = authHeader;
      }

      const res = await fetch(`/api/calls?${params.toString()}`, {
        headers,
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch calls");
      return res.json();
    }
  });

  const calls = paginatedData?.data || [];

  const handleExportCsv = async () => {
    try {
      const params = new URLSearchParams();
      if (searchQuery) params.append("search", searchQuery);
      if (statusFilter !== "all") params.append("status", statusFilter);
      if (sentimentFilter !== "all") params.append("sentiment", sentimentFilter);
      if (directionFilter !== "all") params.append("direction", directionFilter);
      if (leadFilter !== "all") params.append("classification", leadFilter);
      params.append("tab", activeTab);

      const requestHeaders: Record<string, string> = {};
      const authHeader = AuthStorage.getAuthHeader();
      if (authHeader) {
        requestHeaders["Authorization"] = authHeader;
      }

      const res = await fetch(`/api/calls?${params.toString()}`, {
        headers: requestHeaders,
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch calls for export");
      const exportCalls: Call[] = await res.json();

      if (exportCalls.length === 0) {
        toast({
          title: t('common.noData'),
          description: t('calls.noCallsToExport'),
          variant: "destructive",
        });
        return;
      }

      const headers = [
        'ID',
        'Phone Number',
        'Contact Name',
        'Status',
        'Direction',
        'Duration (seconds)',
        'Classification',
        'Sentiment',
        'Campaign',
        'Agent',
        'Engine',
        'Created At'
      ];

      const rows = exportCalls.map(call => {
        const contactName = call.contact 
          ? `${call.contact.firstName} ${call.contact.lastName || ''}`.trim()
          : '';
        const phoneNumber = call.phoneNumber || call.fromNumber || call.toNumber || '';
        
        return [
          call.id,
          phoneNumber,
          contactName,
          call.status,
          call.callDirection || 'outgoing',
          call.duration?.toString() || '0',
          call.classification || '',
          call.sentiment || '',
          call.campaign?.name || '',
          call.agent?.name || '',
          call.engine || 'elevenlabs',
          call.createdAt
        ];
      });

      const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      ].join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', `calls_export_${new Date().toISOString().split('T')[0]}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast({
        title: t('common.exportSuccess'),
        description: t('calls.exportedCalls', { count: exportCalls.length }),
      });
    } catch (err) {
      toast({
        title: "Export failed",
        description: "An error occurred while fetching calls for export.",
        variant: "destructive",
      });
    }
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20">{t('calls.status.completed')}</Badge>;
      case "failed":
        return <Badge className="bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20">{t('calls.status.failed')}</Badge>;
      case "credit_failed":
        return (
          <Badge
            className="bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20 gap-1"
            data-testid="badge-credit-failed"
          >
            <XCircle className="h-3 w-3" />
            Not Billed - Low Credits
          </Badge>
        );
      case "in_progress":
      case "in-progress":
        return <Badge className="bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20">{t('calls.status.inProgress')}</Badge>;
      case "ended":
        return <Badge className="bg-slate-500/10 text-slate-700 dark:text-slate-400 border-slate-500/20">{t('calls.status.ended')}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getSentimentBadge = (sentiment: string | null) => {
    if (!sentiment) return null;
    switch (sentiment) {
      case "positive":
        return <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20">{t('calls.sentiment.positive')}</Badge>;
      case "negative":
        return <Badge className="bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20">{t('calls.sentiment.negative')}</Badge>;
      case "neutral":
        return <Badge className="bg-slate-500/10 text-slate-700 dark:text-slate-400 border-slate-500/20">{t('calls.sentiment.neutral')}</Badge>;
      default:
        return <Badge variant="outline">{sentiment}</Badge>;
    }
  };

  const getClassificationBadge = (classification: string | null) => {
    if (!classification) return null;
    switch (classification) {
      case "hot":
        return <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20">{t('calls.classification.hot')}</Badge>;
      case "warm":
        return <Badge className="bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20">{t('calls.classification.warm')}</Badge>;
      case "cold":
        return <Badge className="bg-slate-500/10 text-slate-700 dark:text-slate-400 border-slate-500/20">{t('calls.classification.cold')}</Badge>;
      case "lost":
        return <Badge className="bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20">{t('calls.classification.lost')}</Badge>;
      case "completed_successful":
        return <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20">{t('calls.classification.successful')}</Badge>;
      case "completed_failed":
        return <Badge className="bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20">{t('calls.status.failed')}</Badge>;
      case "completed":
        return <Badge className="bg-slate-500/10 text-slate-700 dark:text-slate-400 border-slate-500/20">{t('calls.status.completed')}</Badge>;
      default:
        return <Badge variant="outline">{classification}</Badge>;
    }
  };

  const getEngineBadge = (engine?: string) => {
    if (engine === 'twilio-openai') {
      return <Badge className="bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20">Twilio+OpenAI</Badge>;
    }
    if (engine === 'plivo-openai') {
      return <Badge className="bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20">Plivo+OpenAI</Badge>;
    }
    if (engine === 'openai') {
      return <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20">OpenAI</Badge>;
    }
    if (engine === 'custom-voice-engine') {
      return <Badge className="bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20">Custom Voice</Badge>;
    }
    return <Badge className="bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20">ElevenLabs</Badge>;
  };

  const getWidgetBadge = (call: Call) => {
    if (!call.widgetId) return null;
    return (
      <Badge className="bg-brand/10 text-brand border-brand/20 gap-1">
        <Globe className="h-3 w-3" />
        {call.widget?.name || 'Widget'}
      </Badge>
    );
  };

  const formatRelativeTime = (dateString: string | null) => {
    if (!dateString) return null;
    try {
      return formatDistanceToNow(new Date(dateString), { addSuffix: true });
    } catch {
      return null;
    }
  };

  const hasRecording = (call: Call) => {
    if (call.recordingUrl || call.elevenLabsConversationId) return true;
    if (call.engine === 'twilio-openai' || call.engine === 'plivo-openai' || call.engine === 'custom-voice-engine') return true;
    return false;
  };

  const isOpenAIEngine = (call: Call) => {
    return call.engine === 'openai';
  };

  const handlePlayRecording = async (e: React.MouseEvent, call: Call) => {
    e.stopPropagation();
    
    if (playingCallId === call.id) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setPlayingCallId(null);
      currentPlayingIdRef.current = null;
      return;
    }
    
    if (audioRef.current) {
      audioRef.current.pause();
    }
    
    currentPlayingIdRef.current = call.id;
    setLoadingRecording(call.id);
    
    try {
      const headers: Record<string, string> = {};
      const authHeader = AuthStorage.getAuthHeader();
      if (authHeader) {
        headers["Authorization"] = authHeader;
      }
      
      const response = await fetch(`/api/calls/${call.id}/recording`, {
        headers,
        credentials: "include",
      });
      
      if (currentPlayingIdRef.current !== call.id) {
        return;
      }
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to fetch recording");
      }
      
      const blob = await response.blob();
      
      if (currentPlayingIdRef.current !== call.id) {
        return;
      }
      
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      
      if (currentPlayingIdRef.current !== call.id) {
        URL.revokeObjectURL(audioUrl);
        return;
      }
      
      audioRef.current = audio;
      setPlayingCallId(call.id);
      setLoadingRecording(null);
      
      audio.onended = () => {
        if (currentPlayingIdRef.current === call.id) {
          setPlayingCallId(null);
          audioRef.current = null;
        }
        URL.revokeObjectURL(audioUrl);
      };
      
      audio.onerror = () => {
        if (currentPlayingIdRef.current === call.id) {
          setPlayingCallId(null);
          audioRef.current = null;
        }
        toast({
          title: "Playback Error",
          description: "Unable to play this recording.",
          variant: "destructive",
        });
      };
      
      await audio.play();
    } catch (error: any) {
      if (currentPlayingIdRef.current === call.id) {
        setLoadingRecording(null);
        setPlayingCallId(null);
      }
      toast({
        title: "Recording Unavailable",
        description: error.message || "Could not load recording. Try syncing recordings first.",
        variant: "destructive",
      });
    }
  };

  const getDirectionIcon = (direction: string | null) => {
    if (direction === 'incoming') {
      return <PhoneIncoming className="h-4 w-4 text-emerald-500" />;
    }
    return <PhoneOutgoing className="h-4 w-4 text-blue-500" />;
  };

  const totalCalls = paginatedData?.stats?.totalCalls || 0;
  const completedCalls = paginatedData?.stats?.completedCalls || 0;
  const incomingCalls = paginatedData?.stats?.incomingCalls || 0;
  const outgoingCalls = paginatedData?.stats?.outgoingCalls || 0;

  const allCount = paginatedData?.stats?.allCount || 0;
  const transcribedCount = paginatedData?.stats?.transcribedCount || 0;
  const recordingsCount = paginatedData?.stats?.recordingsCount || 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const renderCallCard = (call: Call, testIdPrefix: string = "") => (
    <div 
      key={call.id}
      className="group bg-card border rounded-lg overflow-hidden hover:shadow-lg transition-all duration-200 cursor-pointer"
      onClick={() => setLocation(`/app/calls/${call.id}`)}
      data-testid={`card-call-${testIdPrefix}${call.id}`}
    >
      <div className="flex">
        <div className={`w-1 ${call.status === 'completed' ? 'bg-emerald-500' : (call.status === 'failed' || call.status === 'credit_failed') ? 'bg-rose-500' : 'bg-amber-500'}`} />
        
        <div className="flex-1 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <div className={`flex-shrink-0 h-10 w-10 rounded-full flex items-center justify-center ${
                call.callDirection === 'incoming' 
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' 
                  : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
              }`}>
                {getDirectionIcon(call.callDirection)}
              </div>
              
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold text-foreground truncate">
                    {(() => {
                      // Widget calls: show widget name or "Website Widget"
                      if (call.widgetId) {
                        return call.widget?.name || (call.metadata as any)?.widgetName || 'Website Widget';
                      }
                      const hasContactName = call.contact?.firstName && call.contact.firstName.toLowerCase() !== 'unknown';
                      if (hasContactName) {
                        return `${call.contact!.firstName} ${call.contact!.lastName || ""}`.trim();
                      }
                      if (call.callDirection === 'incoming') {
                        return formatSipEndpoint(call.fromNumber, call.engine) || call.contact?.phone || call.phoneNumber || `Call ${call.id.slice(0, 8)}`;
                      }
                      return formatSipEndpoint(call.toNumber, call.engine) || call.contact?.phone || call.phoneNumber || `Call ${call.id.slice(0, 8)}`;
                    })()}
                  </h3>
                  {getEngineBadge(call.engine)}
                  {getWidgetBadge(call)}
                  {getStatusBadge(call.status)}
                  {getSentimentBadge(call.sentiment)}
                  {getClassificationBadge(call.classification)}
                </div>
                
                <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground flex-wrap">
                  {call.callDirection === 'incoming' ? (
                    <>
                      {call.fromNumber && (
                        <span className="font-mono text-xs flex items-center gap-1">
                          <span className="text-muted-foreground/70">From:</span> {formatSipEndpoint(call.fromNumber, call.engine)}
                        </span>
                      )}
                      {call.toNumber && (
                        <span className="font-mono text-xs flex items-center gap-1">
                          <span className="text-muted-foreground/70">To:</span> {formatSipEndpoint(call.toNumber, call.engine)}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      {call.toNumber && (
                        <span className="font-mono text-xs flex items-center gap-1">
                          <span className="text-muted-foreground/70">To:</span> {formatSipEndpoint(call.toNumber, call.engine)}
                        </span>
                      )}
                      {call.fromNumber && (
                        <span className="font-mono text-xs flex items-center gap-1">
                          <span className="text-muted-foreground/70">From:</span> {formatSipEndpoint(call.fromNumber, call.engine)}
                        </span>
                      )}
                    </>
                  )}
                  {call.campaign && (
                    <span className="truncate max-w-[150px]">{call.campaign.name}</span>
                  )}
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-2 flex-shrink-0">
              {hasRecording(call) && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 rounded-full"
                  onClick={(e) => handlePlayRecording(e, call)}
                  disabled={loadingRecording === call.id}
                  data-testid={`button-play-${testIdPrefix}${call.id}`}
                >
                  {loadingRecording === call.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : playingCallId === call.id ? (
                    <Pause className="h-4 w-4 text-primary" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                </Button>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-4 mt-3 flex-wrap">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span className="font-medium">{formatDuration(call.duration)}</span>
            </div>
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Calendar className="h-3.5 w-3.5" />
              <span>{formatCallDate(call.createdAt)}</span>
            </div>
          </div>
          
          {(call.aiSummary || call.transcript) && (
            <div className="mt-3 pt-3 border-t border-border/50">
              {call.aiSummary && (
                <div className="flex items-start gap-2">
                  <Sparkles className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {call.aiSummary}
                  </p>
                </div>
              )}
              {!call.aiSummary && call.transcript && (
                <div className="flex items-start gap-2">
                  <MessageSquare className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {call.transcript}
                  </p>
                </div>
              )}
            </div>
          )}
          
          <div className="flex items-center justify-between gap-2 mt-3">
            <div className="flex items-center gap-2">
              {hasRecording(call) ? (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Mic className="h-3 w-3" />
                  <span>{t('calls.details.recording')}</span>
                </div>
              ) : isOpenAIEngine(call) ? (
                <div className="flex items-center gap-1 text-xs text-muted-foreground/50" title="OpenAI calls don't have server-side recordings">
                  <Mic className="h-3 w-3" />
                  <span className="line-through">Recording N/A</span>
                </div>
              ) : null}
              {call.transcript && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <FileText className="h-3 w-3" />
                  <span>{t('calls.details.transcript')}</span>
                </div>
              )}
              {call.aiSummary && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Sparkles className="h-3 w-3" />
                  <span>{t('calls.details.aiAnalysis')}</span>
                </div>
              )}
            </div>
            
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setLocation(`/app/calls/${call.id}`);
              }}
              data-testid={`button-view-details-${testIdPrefix}${call.id}`}
            >
              <Eye className="h-4 w-4 mr-1" />
              {t('calls.viewDetails')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-blue-50 via-indigo-50 to-sky-50 dark:from-blue-950/40 dark:via-indigo-950/30 dark:to-sky-950/40 border p-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg">
              <Phone className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">{t('calls.title')}</h1>
              <p className="text-muted-foreground text-sm">{t('calls.description')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isDemoMode && (
              <Button
                variant="outline"
                onClick={() => setIsVideoOpen(true)}
                className="bg-white/80 dark:bg-white/10 hover:bg-white text-blue-900 dark:text-blue-100 border-blue-200 dark:border-blue-800 font-semibold shadow"
                data-testid="button-watch-demo-calls"
              >
                <Video className="h-4 w-4 mr-2 text-blue-600 dark:text-blue-400" />
                <span>Watch Demo Video</span>
              </Button>
            )}
            <Button 
              variant="default"
              onClick={handleExportCsv}
              data-testid="button-export-calls"
            >
              <Download className="h-4 w-4 mr-2" />
              {t('common.export')}
            </Button>
          </div>
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
          <div className="bg-background/60 backdrop-blur-sm rounded-lg p-3 border">
            <div className="flex items-center gap-2">
              <Phone className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              <span className="text-2xl font-bold text-foreground" data-testid="text-total-calls">{totalCalls}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t('calls.stats.totalCalls')}</p>
          </div>
          <div className="bg-background/60 backdrop-blur-sm rounded-lg p-3 border">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span className="text-2xl font-bold text-foreground">{completedCalls}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t('calls.status.completed')}</p>
          </div>
          <div className="bg-background/60 backdrop-blur-sm rounded-lg p-3 border">
            <div className="flex items-center gap-2">
              <PhoneIncoming className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span className="text-2xl font-bold text-foreground">{incomingCalls}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t('calls.filters.incoming')}</p>
          </div>
          <div className="bg-background/60 backdrop-blur-sm rounded-lg p-3 border">
            <div className="flex items-center gap-2">
              <PhoneOutgoing className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              <span className="text-2xl font-bold text-foreground">{outgoingCalls}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t('calls.filters.outgoing')}</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] w-full sm:w-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('calls.searchPlaceholder')}
            className="pl-9"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="input-search-calls"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-[130px]" data-testid="select-filter-status">
            <SelectValue placeholder={t('calls.details.status')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('calls.filters.allStatus')}</SelectItem>
            <SelectItem value="completed">{t('calls.status.completed')}</SelectItem>
            <SelectItem value="failed">{t('calls.status.failed')}</SelectItem>
            <SelectItem value="credit_failed" data-testid="filter-status-credit-failed">Not Billed - Low Credits</SelectItem>
            <SelectItem value="in_progress">{t('calls.status.inProgress')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sentimentFilter} onValueChange={setSentimentFilter}>
          <SelectTrigger className="w-full sm:w-[130px]" data-testid="select-filter-sentiment">
            <SelectValue placeholder={t('calls.details.sentiment')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('calls.filters.allSentiment')}</SelectItem>
            <SelectItem value="positive">{t('calls.sentiment.positive')}</SelectItem>
            <SelectItem value="neutral">{t('calls.sentiment.neutral')}</SelectItem>
            <SelectItem value="negative">{t('calls.sentiment.negative')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={directionFilter} onValueChange={setDirectionFilter}>
          <SelectTrigger className="w-full sm:w-[130px]" data-testid="select-filter-direction">
            <SelectValue placeholder={t('calls.details.direction')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('calls.filters.allDirections')}</SelectItem>
            <SelectItem value="incoming">{t('calls.filters.incoming')}</SelectItem>
            <SelectItem value="outgoing">{t('calls.filters.outgoing')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={leadFilter} onValueChange={setLeadFilter}>
          <SelectTrigger className="w-full sm:w-[130px]" data-testid="select-filter-lead">
            <SelectValue placeholder={t('calls.filters.leadQuality')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('calls.filters.allLeads')}</SelectItem>
            <SelectItem value="hot">{t('calls.classification.hot')}</SelectItem>
            <SelectItem value="warm">{t('calls.classification.warm')}</SelectItem>
            <SelectItem value="cold">{t('calls.classification.cold')}</SelectItem>
            <SelectItem value="lost">{t('calls.classification.lost')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="all" data-testid="tab-all">
            {t('calls.allCalls')} ({allCount})
          </TabsTrigger>
          <TabsTrigger value="transcribed" data-testid="tab-transcribed">
            {t('calls.transcribed')} ({transcribedCount})
          </TabsTrigger>
          <TabsTrigger value="recordings" data-testid="tab-recordings">
            {t('calls.recordings')} ({recordingsCount})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="space-y-3">
          {calls.length === 0 ? (
            <Card className="p-12 text-center">
              <Phone className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <h3 className="font-medium text-lg mb-1">{t('calls.noCalls')}</h3>
              <p className="text-muted-foreground text-sm">
                {paginatedData?.stats?.totalCalls === 0 
                  ? t('calls.createCampaignToStart') 
                  : t('calls.noMatchingFilters')}
              </p>
            </Card>
          ) : (
            <>
              <div className="grid gap-3">
                {calls.map((call) => renderCallCard(call))}
              </div>
              <DataPagination
                currentPage={page}
                totalPages={paginatedData?.pagination.totalPages || 1}
                totalItems={paginatedData?.pagination.totalItems || 0}
                itemsPerPage={pageSize}
                onPageChange={setPage}
                onItemsPerPageChange={setPageSize}
                data-testid="pagination-all-calls"
              />
            </>
          )}
        </TabsContent>

        <TabsContent value="transcribed" className="space-y-3">
          {calls.length === 0 ? (
            <Card className="p-12 text-center">
              <FileText className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <h3 className="font-medium text-lg mb-1">{t('calls.noTranscribed')}</h3>
              <p className="text-muted-foreground text-sm">
                {t('calls.transcriptsWillAppear')}
              </p>
            </Card>
          ) : (
            <>
              <div className="grid gap-3">
                {calls.map((call) => renderCallCard(call, "transcribed-"))}
              </div>
              <DataPagination
                currentPage={page}
                totalPages={paginatedData?.pagination.totalPages || 1}
                totalItems={paginatedData?.pagination.totalItems || 0}
                itemsPerPage={pageSize}
                onPageChange={setPage}
                onItemsPerPageChange={setPageSize}
                data-testid="pagination-transcribed-calls"
              />
            </>
          )}
        </TabsContent>

        <TabsContent value="recordings" className="space-y-3">
          {calls.length === 0 ? (
            <Card className="p-12 text-center">
              <Mic className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <h3 className="font-medium text-lg mb-1">{t('calls.noRecordings')}</h3>
              <p className="text-muted-foreground text-sm">
                {t('calls.trySyncRecordings')}
              </p>
            </Card>
          ) : (
            <>
              <div className="grid gap-3">
                {calls.map((call) => renderCallCard(call, "recording-"))}
              </div>
              <DataPagination
                currentPage={page}
                totalPages={paginatedData?.pagination.totalPages || 1}
                totalItems={paginatedData?.pagination.totalItems || 0}
                itemsPerPage={pageSize}
                onPageChange={setPage}
                onItemsPerPageChange={setPageSize}
                data-testid="pagination-recordings-calls"
              />
            </>
          )}
        </TabsContent>
      </Tabs>

      {isDemoMode && (
        <Dialog open={isVideoOpen} onOpenChange={setIsVideoOpen}>
          <DialogContent className="sm:max-w-[850px] p-2 bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
            <DialogHeader className="p-4 pb-2 text-left">
              <DialogTitle className="text-lg font-bold text-white flex items-center gap-2">
                <Play className="h-5 w-5 text-blue-400 fill-blue-400" />
                Call Logs & Analytics Demonstration Video
              </DialogTitle>
              <DialogDescription className="text-xs text-slate-400">
                Watch a demonstration on reviewing call logs, audio recordings, transcripts, and AI analysis.
              </DialogDescription>
            </DialogHeader>
            <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-black border border-slate-800">
              {isVideoOpen && (
                <iframe
                  src="https://drive.google.com/file/d/1NFAlAXnwjw_GiWKOM83F2MpkLgFCZeSc/preview"
                  className="w-full h-full border-0"
                  allow="autoplay; encrypted-media; picture-in-picture"
                  allowFullScreen
                  title="Call Logs Demo Video"
                />
              )}
            </div>
            <div className="p-3 pt-2 text-right">
              <a
                href="https://drive.google.com/file/d/1NFAlAXnwjw_GiWKOM83F2MpkLgFCZeSc/view?usp=drive_link"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-400 hover:underline inline-flex items-center gap-1 font-medium"
              >
                Open in Google Drive &rarr;
              </a>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
