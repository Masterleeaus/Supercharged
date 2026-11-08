import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ClipboardList, Calendar, Webhook, Globe, Key, Users, Mail, ContactRound, Link as LinkIcon, TableProperties, ExternalLink, Unlink, Loader2, Video, Play } from "lucide-react";
import { usePluginStatus } from "@/hooks/use-plugin-status";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDemoMode } from "@/components/DemoModeBanner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

interface ToolCard {
  id: string;
  title: string;
  description: string;
  icon: typeof ClipboardList;
  iconColor: string;
  iconBg: string;
  url: string;
  pluginRequired?: string;
}

function GoogleSheetsCardActions() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [connecting, setConnecting] = useState(false);

  const { data: status, isLoading } = useQuery<{ connected: boolean; email?: string }>({
    queryKey: ["/api/integrations/google/status"],
    retry: false,
  });

  const disconnectMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/integrations/google/disconnect"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/google/status"] });
      toast({ title: t('toolsPage.googleAccountDisconnected', 'Google account disconnected') });
    },
    onError: () => {
      toast({ title: t('toolsPage.failedToDisconnect', 'Failed to disconnect'), variant: "destructive" });
    },
  });

  const handleConnect = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setConnecting(true);
    try {
      const res = await apiRequest("GET", "/api/integrations/google/auth");
      const body = await res.json();
      window.location.href = body.url;
    } catch (err: any) {
      const errData = err?.data ?? err?.response;
      const description = errData?.errorCode === "not_configured"
        ? t('toolsPage.googleOAuthNotConfigured', 'Google OAuth credentials are not configured. Please add them in Admin > Settings.')
        : errData?.error || undefined;
      toast({ title: t('toolsPage.googleConnectionFailed', 'Google connection failed'), description, variant: "destructive" });
      setConnecting(false);
    }
  };

  const handleDisconnect = (e: React.MouseEvent) => {
    e.stopPropagation();
    disconnectMutation.mutate();
  };

  if (isLoading) {
    return <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />;
  }

  if (status?.connected) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="default" className="text-xs" data-testid="badge-google-sheets-status">
          {t('toolsPage.connected', 'Connected')}
        </Badge>
        {status.email && (
          <span className="text-xs text-green-600 dark:text-green-400 truncate max-w-[160px]" data-testid="text-google-sheets-email">
            {status.email}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground"
          onClick={handleDisconnect}
          disabled={disconnectMutation.isPending}
          data-testid="button-disconnect-google"
        >
          <Unlink className="w-3 h-3 mr-1" />
          {t('toolsPage.disconnect', 'Disconnect')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Badge variant="outline" className="text-xs text-muted-foreground" data-testid="badge-google-sheets-status">
        {t('toolsPage.notConnected', 'Not connected')}
      </Badge>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={handleConnect}
        disabled={connecting}
        data-testid="button-connect-google"
      >
        <ExternalLink className="w-3 h-3 mr-1" />
        {connecting ? t('toolsPage.redirecting', 'Redirecting...') : t('toolsPage.connect', 'Connect')}
      </Button>
    </div>
  );
}

export default function ToolsPage() {
  const { t } = useTranslation();
  const { isDemoMode } = useDemoMode();
  const [isVideoOpen, setIsVideoOpen] = useState(false);
  const [, setLocation] = useLocation();
  const { isPluginEnabled, isLoading } = usePluginStatus();
  const { toast } = useToast();

  const allTools: ToolCard[] = useMemo(() => [
    {
      id: "forms",
      title: t('toolsPage.tools.forms.title', 'Forms'),
      description: t('toolsPage.tools.forms.description', 'Create and manage forms to collect data from your contacts and leads.'),
      icon: ClipboardList,
      iconColor: "text-cyan-600 dark:text-cyan-400",
      iconBg: "bg-cyan-500/10 dark:bg-cyan-500/20",
      url: "/app/flows/forms",
    },
    {
      id: "appointments",
      title: t('toolsPage.tools.appointments.title', 'Appointments'),
      description: t('toolsPage.tools.appointments.description', 'Manage appointment bookings from your AI agents and forms.'),
      icon: Calendar,
      iconColor: "text-rose-600 dark:text-rose-400",
      iconBg: "bg-rose-500/10 dark:bg-rose-500/20",
      url: "/app/flows/appointments",
    },
    {
      id: "webhooks",
      title: t('toolsPage.tools.webhooks.title', 'Webhooks'),
      description: t('toolsPage.tools.webhooks.description', 'Configure webhook endpoints to receive real-time event notifications.'),
      icon: Webhook,
      iconColor: "text-violet-600 dark:text-violet-400",
      iconBg: "bg-violet-500/10 dark:bg-violet-500/20",
      url: "/app/flows/webhooks",
    },
    {
      id: "widget",
      title: t('toolsPage.tools.widget.title', 'Website Widget'),
      description: t('toolsPage.tools.widget.description', 'Embed an AI chat widget on your website for visitor engagement.'),
      icon: Globe,
      iconColor: "text-sky-600 dark:text-sky-400",
      iconBg: "bg-sky-500/10 dark:bg-sky-500/20",
      url: "/app/tools/widgets",
    },
    {
      id: "crm",
      title: t('toolsPage.tools.crm.title', 'Quick CRM'),
      description: t('toolsPage.tools.crm.description', 'Organize and manage your leads with a kanban board and contact filters.'),
      icon: ContactRound,
      iconColor: "text-cyan-600 dark:text-cyan-400",
      iconBg: "bg-cyan-500/10 dark:bg-cyan-500/20",
      url: "/app/crm",
    },
    {
      id: "incoming-connections",
      title: t('toolsPage.tools.incomingConnections.title', 'Incoming Connections'),
      description: t('toolsPage.tools.incomingConnections.description', 'Manage incoming call routing and connect callers to your AI agents.'),
      icon: LinkIcon,
      iconColor: "text-amber-600 dark:text-amber-400",
      iconBg: "bg-amber-500/10 dark:bg-amber-500/20",
      url: "/app/incoming-connections",
    },
    {
      id: "developer",
      title: t('toolsPage.tools.developer.title', 'Developer / API Keys'),
      description: t('toolsPage.tools.developer.description', 'Manage API keys and access REST API documentation.'),
      icon: Key,
      iconColor: "text-amber-600 dark:text-amber-400",
      iconBg: "bg-amber-500/10 dark:bg-amber-500/20",
      url: "/app/settings?tab=developer",
      pluginRequired: "rest-api",
    },
    {
      id: "team",
      title: t('toolsPage.tools.team.title', 'Team Management'),
      description: t('toolsPage.tools.team.description', 'Invite team members, assign roles, and manage permissions.'),
      icon: Users,
      iconColor: "text-blue-600 dark:text-blue-400",
      iconBg: "bg-blue-500/10 dark:bg-blue-500/20",
      url: "/app/settings?tab=team",
      pluginRequired: "team-management",
    },
    {
      id: "messaging",
      title: t('toolsPage.tools.messaging.title', 'WhatsApp & Email'),
      description: t('toolsPage.tools.messaging.description', 'Configure WhatsApp Business and email messaging for your agents.'),
      icon: Mail,
      iconColor: "text-emerald-600 dark:text-emerald-400",
      iconBg: "bg-emerald-500/10 dark:bg-emerald-500/20",
      url: "/app/settings?tab=messaging",
      pluginRequired: "messaging",
    },
    {
      id: "google-sheets",
      title: t('toolsPage.tools.googleSheets.title', 'Google Sheets'),
      description: t('toolsPage.tools.googleSheets.description', 'Push appointment and form data to Google Sheets in real time.'),
      icon: TableProperties,
      iconColor: "text-green-600 dark:text-green-400",
      iconBg: "bg-green-500/10 dark:bg-green-500/20",
      url: "/app/tools",
    },
  ], [t]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const googleConnected = params.get("google_connected");
    const googleError = params.get("google_error");
    if (googleConnected === "true") {
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/google/status"] });
      toast({ title: t('toolsPage.googleAccountConnected', 'Google account connected successfully') });
      window.history.replaceState({}, "", "/app/tools");
    } else if (googleError) {
      const messages: Record<string, string> = {
        access_denied: t('toolsPage.accessDenied', 'Access was denied. Please try again.'),
        invalid_state: t('toolsPage.invalidState', 'OAuth state was invalid or expired. Please try connecting again.'),
        no_refresh_token: t('toolsPage.noRefreshToken', 'No refresh token received. Please re-connect and grant offline access.'),
        token_exchange_failed: t('toolsPage.tokenExchangeFailed', 'Failed to exchange token. Please try again.'),
        not_configured: t('toolsPage.notConfigured', 'Google OAuth is not configured on this server.'),
        server_error: t('toolsPage.serverError', 'A server error occurred. Please try again.'),
      };
      toast({
        title: t('toolsPage.googleConnectionFailed', 'Google connection failed'),
        description: messages[googleError] || t('toolsPage.unknownError', 'An unknown error occurred.'),
        variant: "destructive",
      });
      window.history.replaceState({}, "", "/app/tools");
    }
  }, [t]);

  const visibleTools = allTools.filter((tool) => {
    if (!tool.pluginRequired) return true;
    return isPluginEnabled?.(tool.pluginRequired) ?? false;
  });

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-tools-title">{t('toolsPage.title', 'Tools')}</h1>
          <p className="text-muted-foreground mt-1" data-testid="text-tools-description">
            {t('toolsPage.description', 'Access and configure your platform tools and integrations.')}
          </p>
        </div>
        {isDemoMode && (
          <Button
            variant="outline"
            onClick={() => setIsVideoOpen(true)}
            className="border-primary/30 text-primary hover:bg-primary/10 font-semibold flex items-center gap-2 self-start sm:self-auto"
            data-testid="button-watch-demo-tools"
          >
            <Video className="h-4 w-4" />
            <span>Watch Demo Video</span>
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-5">
                <div className="flex items-start gap-4">
                  <div className="w-11 h-11 rounded-md bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-muted rounded w-24" />
                    <div className="h-3 bg-muted rounded w-full" />
                    <div className="h-3 bg-muted rounded w-3/4" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleTools.map((tool) => (
            <Card
              key={tool.id}
              className="cursor-pointer hover-elevate active-elevate-2 transition-colors"
              onClick={() => setLocation(tool.url)}
              data-testid={`card-tool-${tool.id}`}
            >
              <CardContent className="p-5">
                <div className="flex items-start gap-4">
                  <div className={`w-11 h-11 rounded-md ${tool.iconBg} flex items-center justify-center shrink-0`}>
                    <tool.icon className={`w-5 h-5 ${tool.iconColor}`} />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <h3 className="font-semibold text-sm text-foreground">{tool.title}</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">{tool.description}</p>
                    {tool.id === "google-sheets" && (
                      <div className="pt-1">
                        <GoogleSheetsCardActions />
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {isDemoMode && (
        <Dialog open={isVideoOpen} onOpenChange={setIsVideoOpen}>
          <DialogContent className="sm:max-w-[850px] p-2 bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
            <DialogHeader className="p-4 pb-2 text-left">
              <DialogTitle className="text-lg font-bold text-white flex items-center gap-2">
                <Play className="h-5 w-5 text-emerald-400 fill-emerald-400" />
                Tools & Integrations Demonstration Video
              </DialogTitle>
              <DialogDescription className="text-xs text-slate-400">
                Watch a overview demonstration on using platform tools and integrations.
              </DialogDescription>
            </DialogHeader>
            <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-black border border-slate-800">
              {isVideoOpen && (
                <iframe
                  src="https://drive.google.com/file/d/1tjt72sbOJ3Xo9anHMNbF1Jtkl6w0BMbJ/preview"
                  className="w-full h-full border-0"
                  allow="autoplay; encrypted-media; picture-in-picture"
                  allowFullScreen
                  title="Tools & Integrations Demo Video"
                />
              )}
            </div>
            <div className="p-3 pt-2 text-right">
              <a
                href="https://drive.google.com/file/d/1tjt72sbOJ3Xo9anHMNbF1Jtkl6w0BMbJ/view?usp=drive_link"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-brand hover:underline inline-flex items-center gap-1 font-medium"
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

