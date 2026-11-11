
/**
 * Admin Voice Engine Settings
 * Manages API keys, active providers, FreeSWITCH nodes, and SIP trunking templates.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Mic, Brain, Volume2, Phone, Server, Database } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDemoMode } from "@/components/DemoModeBanner";
import { ProviderSettings, FreeSwitchNode, SipGateway, StatusBadge, StorageSettingsTab } from "@/components/admin/voice-engine-settings/shared";
import { SpeechSettingsTab } from "@/components/admin/voice-engine-settings/SpeechSettingsTab";
import { LlmSettingsTab } from "@/components/admin/voice-engine-settings/LlmSettingsTab";
import { NodesSettingsTab } from "@/components/admin/voice-engine-settings/NodesSettingsTab";
import { TelephonySettingsTab } from "@/components/admin/voice-engine-settings/TelephonySettingsTab";
import { FreeSwitchNodeDialog } from "@/components/admin/voice-engine-settings/FreeSwitchNodeDialog";
import { SipGatewayDialog } from "@/components/admin/voice-engine-settings/SipGatewayDialog";

export default function VoiceEngineSettings() {
  const { toast } = useToast();
  const { isDemoMode } = useDemoMode();
  const [activeTab, setActiveTab] = useState("speech");
  const [testResults, setTestResults] = useState<Record<string, { connected: boolean; details: string }>>({});
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [isNodeDialogOpen, setIsNodeDialogOpen] = useState(false);
  const [editingNode, setEditingNode] = useState<FreeSwitchNode | null>(null);
  const [nodeName, setNodeName] = useState("");
  const [eslHost, setEslHost] = useState("127.0.0.1");
  const [eslPort, setEslPort] = useState("8021");
  const [eslPassword, setEslPassword] = useState("ClueCon");
  const [sipHost, setSipHost] = useState("");
  const [sipPort, setSipPort] = useState("5060");
  const [wsPort, setWsPort] = useState("8089");
  const [maxCalls, setMaxCalls] = useState("100");
  const [nodeStatus, setNodeStatus] = useState<'online' | 'offline' | 'degraded' | 'maintenance'>("offline");
  const [orSearch, setOrSearch] = useState("");
  const [selectedSipProvider, setSelectedSipProvider] = useState("twilio");
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // SIP Gateways state
  const [isGatewayDialogOpen, setIsGatewayDialogOpen] = useState(false);
  const [editingGateway, setEditingGateway] = useState<SipGateway | null>(null);
  const [gwName, setGwName] = useState("");
  const [gwUsername, setGwUsername] = useState("");
  const [gwPassword, setGwPassword] = useState("");
  const [gwProxy, setGwProxy] = useState("");
  const [gwRegister, setGwRegister] = useState(false);
  const [gwCallerIdInFrom, setGwCallerIdInFrom] = useState(true);

  const { data: keysData, isLoading: isKeysLoading } = useQuery<{ success: boolean; data: ProviderSettings }>({
    queryKey: ["/api/voice-engine/admin/provider-keys"],
    staleTime: 30000,
  });

  const { data: nodesData, isLoading: isNodesLoading, refetch: refetchNodes } = useQuery<{ success: boolean; data: FreeSwitchNode[] }>({
    queryKey: ["/api/voice-engine/admin/settings/nodes"],
    staleTime: 30000,
  });

  const { data: gatewaysData, isLoading: isGatewaysLoading, refetch: refetchGateways } = useQuery<{ success: boolean; data: SipGateway[] }>({
    queryKey: ["/api/voice-engine/admin/settings/sip-gateways"],
    staleTime: 30000,
  });

  const gateways = gatewaysData?.data || [];

  const saveGatewayMutation = useMutation({
    mutationFn: async (payload: any) => {
      if (editingGateway) {
        const res = await apiRequest("PUT", `/api/voice-engine/admin/settings/sip-gateways/${editingGateway.id}`, payload);
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/voice-engine/admin/settings/sip-gateways", payload);
        return res.json();
      }
    },
    onSuccess: () => {
      refetchGateways();
      setIsGatewayDialogOpen(false);
      resetGatewayForm();
      toast({
        title: editingGateway ? "Gateway Updated" : "Gateway Added",
        description: `SIP Gateway has been successfully ${editingGateway ? "updated" : "added"}.`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Error Saving Gateway", description: err.message, variant: "destructive" });
    },
  });

  const deleteGatewayMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/voice-engine/admin/settings/sip-gateways/${id}`);
      return res.json();
    },
    onSuccess: () => {
      refetchGateways();
      toast({ title: "Gateway Deleted", description: "SIP Gateway deleted successfully." });
    },
    onError: (err: any) => {
      toast({ title: "Error Deleting Gateway", description: err.message, variant: "destructive" });
    },
  });

  const activateGatewayMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/voice-engine/admin/settings/sip-gateways/${id}/activate`);
      return res.json();
    },
    onSuccess: () => {
      refetchGateways();
      toast({ title: "Gateway Activated", description: "Selected SIP Gateway is now active." });
    },
    onError: (err: any) => {
      toast({ title: "Error Activating Gateway", description: err.message, variant: "destructive" });
    },
  });

  const resetGatewayForm = () => {
    setEditingGateway(null);
    setGwName("");
    setGwUsername("");
    setGwPassword("");
    setGwProxy("");
    setGwRegister(false);
    setGwCallerIdInFrom(true);
  };

  const handleOpenAddGatewayDialog = () => {
    resetGatewayForm();
    setIsGatewayDialogOpen(true);
  };

  const handleOpenEditGatewayDialog = (gw: SipGateway) => {
    setEditingGateway(gw);
    setGwName(gw.name);
    setGwUsername(gw.username);
    setGwPassword(gw.password || "");
    setGwProxy(gw.proxy);
    setGwRegister(gw.register);
    setGwCallerIdInFrom(gw.caller_id_in_from);
    setIsGatewayDialogOpen(true);
  };

  const handleSaveGateway = () => {
    if (!gwName.trim() || !gwUsername.trim() || !gwPassword.trim() || !gwProxy.trim()) {
      toast({ title: "Validation Error", description: "Name, Username, Password, and Proxy are required.", variant: "destructive" });
      return;
    }
    saveGatewayMutation.mutate({
      name: gwName,
      username: gwUsername,
      password: gwPassword,
      proxy: gwProxy,
      register: gwRegister,
      callerIdInFrom: gwCallerIdInFrom,
    });
  };

  const { data: orModelsData, isLoading: isOrModelsLoading } = useQuery<{
    success: boolean;
    data: { id: string; name: string; context_length: number }[];
  }>({
    queryKey: ["/api/voice-engine/admin/provider-keys/openrouter-models"],
    staleTime: 5 * 60 * 1000,
    enabled: !!keysData?.data,
  });

  const settings = keysData?.data;
  const nodes = nodesData?.data || [];
  const orModels = orModelsData?.data ?? [];

  const updateMutation = useMutation({
    mutationFn: async (body: Record<string, any>) => {
      const res = await apiRequest("PUT", "/api/voice-engine/admin/provider-keys", body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/voice-engine/admin/provider-keys"] });
      toast({ title: "Settings saved", description: "Provider settings updated successfully." });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const testProvider = async (provider: string) => {
    setTestingProvider(provider);
    try {
      const res = await apiRequest("POST", `/api/voice-engine/admin/provider-keys/test/${provider}`);
      const result = await res.json();
      setTestResults((prev) => ({ ...prev, [provider]: result.data }));
    } catch {
      setTestResults((prev) => ({ ...prev, [provider]: { connected: false, details: "Test failed" } }));
    } finally {
      setTestingProvider(null);
    }
  };

  const saveNodeMutation = useMutation({
    mutationFn: async (payload: any) => {
      if (editingNode) {
        const res = await apiRequest("PUT", `/api/voice-engine/admin/settings/nodes/${editingNode.id}`, payload);
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/voice-engine/admin/settings/nodes", payload);
        return res.json();
      }
    },
    onSuccess: () => {
      refetchNodes();
      setIsNodeDialogOpen(false);
      resetNodeForm();
      toast({
        title: editingNode ? "Node Updated" : "Node Added",
        description: `FreeSWITCH node has been successfully ${editingNode ? "updated" : "added"}.`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Error Saving Node", description: err.message, variant: "destructive" });
    },
  });

  const deleteNodeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/voice-engine/admin/settings/nodes/${id}`);
      return res.json();
    },
    onSuccess: () => {
      refetchNodes();
      toast({ title: "Node Deleted", description: "FreeSWITCH node deleted successfully." });
    },
    onError: (err: any) => {
      toast({ title: "Error Deleting Node", description: err.message, variant: "destructive" });
    },
  });

  const resetNodeForm = () => {
    setEditingNode(null);
    setNodeName("");
    setEslHost("127.0.0.1");
    setEslPort("8021");
    setEslPassword("ClueCon");
    setSipHost("");
    setSipPort("5060");
    setWsPort("8089");
    setMaxCalls("100");
    setNodeStatus("offline");
  };

  const handleOpenAddDialog = () => { resetNodeForm(); setIsNodeDialogOpen(true); };

  const handleOpenEditDialog = (node: FreeSwitchNode) => {
    setEditingNode(node);
    setNodeName(node.name);
    setEslHost(node.esl_host);
    setEslPort(node.esl_port.toString());
    setEslPassword(node.esl_password || "ClueCon");
    setSipHost(node.sip_host);
    setSipPort(node.sip_port.toString());
    setWsPort(node.ws_port.toString());
    setMaxCalls(node.max_calls.toString());
    setNodeStatus(node.status);
    setIsNodeDialogOpen(true);
  };

  const handleSaveNode = () => {
    if (!nodeName.trim() || !sipHost.trim()) {
      toast({ title: "Validation Error", description: "Node Name and SIP Host are required.", variant: "destructive" });
      return;
    }
    saveNodeMutation.mutate({
      name: nodeName,
      eslHost, eslPort: parseInt(eslPort) || 8021, eslPassword,
      sipHost, sipPort: parseInt(sipPort) || 5060,
      wsPort: parseInt(wsPort) || 8089,
      maxCalls: parseInt(maxCalls) || 100,
      status: nodeStatus,
    });
  };

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(label);
    setTimeout(() => setCopiedText(null), 2000);
  };

  if (isKeysLoading || isNodesLoading || isGatewaysLoading) {
    return <div className="flex items-center justify-center p-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  if (!settings) {
    return <div className="text-center p-8 text-muted-foreground">Failed to load voice engine settings. Make sure the plugin migration has been applied.</div>;
  }

  const sipTemplates: Record<string, { guide: string; gatewayXml: string }> = {
    twilio: {
      guide: `1. Log in to Twilio Console and go to Elastic SIP Trunking > Trunks.\n2. Create a new SIP Trunk. Under Termination, point the SIP URI to sip:<freeswitch-ip>:5060.\n3. Under Origination, add your FreeSWITCH IP as an Origination URI: sip:<freeswitch-ip>.\n4. Save and configure the gateway file below in FreeSWITCH.`,
      gatewayXml: `<gateway name="twilio">\n  <param name="username" value="YOUR_TWILIO_TRUNK_SID"/>\n  <param name="password" value="YOUR_TWILIO_TRUNK_PASSWORD"/>\n  <param name="proxy" value="YOUR_TWILIO_TRUNK.pstn.twilio.com"/>\n  <param name="register" value="false"/>\n</gateway>`
    },
    telnyx: {
      guide: `1. Log in to Telnyx Portal and create a SIP Connection (Credential/IP authentication).\n2. Create an Outbound Voice Profile and map it to your SIP connection.\n3. Buy a phone number (DID) and assign it to route calls to your SIP Connection.\n4. Create the FreeSWITCH Gateway profile XML using the credentials.`,
      gatewayXml: `<gateway name="telnyx">\n  <param name="username" value="YOUR_TELNYX_SIP_USERNAME"/>\n  <param name="password" value="YOUR_TELNYX_SIP_PASSWORD"/>\n  <param name="proxy" value="sip.telnyx.com"/>\n  <param name="register" value="true"/>\n  <param name="expire-seconds" value="600"/>\n</gateway>`
    },
    plivo: {
      guide: `1. Log in to Plivo Console and navigate to Voice > Direct Dial > SIP Trunks.\n2. Add a new SIP Trunk pointing to your FreeSWITCH public IP address.\n3. Rent/assign a phone number and point its XML application URL to your SIP Trunk.\n4. Save the gateway credentials and apply the XML profile below.`,
      gatewayXml: `<gateway name="plivo">\n  <param name="username" value="YOUR_PLIVO_SIP_USERNAME"/>\n  <param name="password" value="YOUR_PLIVO_SIP_PASSWORD"/>\n  <param name="proxy" value="phone.plivo.com"/>\n  <param name="register" value="true"/>\n</gateway>`
    },
    vonage: {
      guide: `1. Log in to Vonage API Dashboard and go to Voice > SIP Trunking.\n2. Create a new SIP Trunk pointing to your FreeSWITCH IP.\n3. Configure the Gateway settings below using your Vonage API Key and Secret.`,
      gatewayXml: `<gateway name="vonage">\n  <param name="username" value="YOUR_VONAGE_API_KEY"/>\n  <param name="password" value="YOUR_VONAGE_API_SECRET"/>\n  <param name="proxy" value="sip.nexmo.com"/>\n  <param name="register" value="true"/>\n</gateway>`
    },
    bandwidth: {
      guide: `1. Log in to Bandwidth Dashboard and configure a SIP Peer for your FreeSWITCH IP.\n2. Create an Associated Credentials set.\n3. Configure the gateway profile XML with your credentials and domain.`,
      gatewayXml: `<gateway name="bandwidth">\n  <param name="username" value="YOUR_BANDWIDTH_USERNAME"/>\n  <param name="password" value="YOUR_BANDWIDTH_PASSWORD"/>\n  <param name="proxy" value="otg.bandwidth.com"/>\n  <param name="register" value="false"/>\n</gateway>`
    },
    sinch: {
      guide: `1. Log in to Sinch Customer Portal and create a new SIP Trunk.\n2. Map the Sinch DID numbers to your FreeSWITCH public IP.\n3. Set up the SIP registration gateway using Sinch credentials.`,
      gatewayXml: `<gateway name="sinch">\n  <param name="username" value="YOUR_SINCH_USERNAME"/>\n  <param name="password" value="YOUR_SINCH_PASSWORD"/>\n  <param name="proxy" value="sip.sinch.com"/>\n  <param name="register" value="true"/>\n</gateway>`
    },
    infobip: {
      guide: `1. Log in to Infobip Portal and navigate to Channels > Voice > SIP Trunks.\n2. Create a new SIP trunk and configure your FreeSWITCH node IP.\n3. Set up the XML gateway with your Infobip credentials.`,
      gatewayXml: `<gateway name="infobip">\n  <param name="username" value="YOUR_INFOBIP_USERNAME"/>\n  <param name="password" value="YOUR_INFOBIP_PASSWORD"/>\n  <param name="proxy" value="sip.infobip.com"/>\n  <param name="register" value="true"/>\n</gateway>`
    },
    agora: {
      guide: `1. Log in to Agora Console and enable the SIP Gateway service.\n2. Configure your destination SIP Server (FreeSWITCH Node) and routing rules.\n3. Set up the XML profile using your Agora app ID / credentials.`,
      gatewayXml: `<gateway name="agora">\n  <param name="username" value="YOUR_AGORA_APP_ID"/>\n  <param name="password" value="YOUR_AGORA_TOKEN"/>\n  <param name="proxy" value="sip.agora.io"/>\n  <param name="register" value="false"/>\n</gateway>`
    },
    restcomm: {
      guide: `1. Open your Restcomm instance or cloud account.\n2. Set up a SIP Connection routing to your FreeSWITCH nodes.\n3. Set up gateway XML configuration with credentials.`,
      gatewayXml: `<gateway name="restcomm">\n  <param name="username" value="YOUR_RESTCOMM_USERNAME"/>\n  <param name="password" value="YOUR_RESTCOMM_PASSWORD"/>\n  <param name="proxy" value="sip.restcomm.com"/>\n  <param name="register" value="true"/>\n</gateway>`
    }
  };

  const dialplanXml = `<extension name="ai_voice_agent">\n  <condition field="destination_number" expression="^(\\+?\\d+)$">\n    <action application="answer"/>\n    <action application="playback" data="silence_stream://500"/>\n    <action application="set" data="tts_engine=flite"/>\n    <action application="set" data="tts_voice=slt"/>\n    <!-- Stream audio to voice-engine plugin WebSocket server -->\n    <action application="audio_fork" data="start ws://<your-node-ip>:8089/voice-engine/ws/audio/\${uuid}"/>\n    <action application="park"/>\n  </condition>\n</extension>`;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Custom Engine</h2>
        <p className="text-muted-foreground">Configure AI API keys, active providers, and manage the connected FreeSWITCH nodes and SIP trunks.</p>
      </div>

      {/* Status Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        {[
          { label: "STT", icon: Mic, provider: settings.stt.activeProvider, providers: settings.stt.providers, color: "blue" },
          { label: "LLM", icon: Brain, provider: settings.llm.activeProvider, providers: settings.llm.providers, color: "purple" },
          { label: "TTS", icon: Volume2, provider: settings.tts.activeProvider, providers: settings.tts.providers, color: "orange" },
        ].map(({ label, icon: Icon, provider, providers, color }) => {
          const active = providers[provider];
          return (
            <Card key={label} className={`border-${color}-200 dark:border-${color}-800/50`}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className={`p-2 rounded-lg bg-${color}-100 dark:bg-${color}-950/40`}>
                  <Icon className={`h-5 w-5 text-${color}-600 dark:text-${color}-400`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground capitalize">{active?.name || provider}</p>
                </div>
                <StatusBadge hasKey={active?.hasKey ?? false} />
              </CardContent>
            </Card>
          );
        })}
        <Card className="border-emerald-200 dark:border-emerald-800/50">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-950/40">
              <Server className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">FS Nodes</p>
              <p className="text-xs text-muted-foreground">{nodes.filter(n => n.status === 'online').length} / {nodes.length} Online</p>
            </div>
            <Badge variant="outline" className="border-emerald-500 text-emerald-600">Active</Badge>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-1 mb-4 h-auto p-1 bg-muted/60">
          <TabsTrigger value="speech" className="py-2.5"><Mic className="h-4 w-4 mr-2" />Speech (STT/TTS)</TabsTrigger>
          <TabsTrigger value="llm" className="py-2.5"><Brain className="h-4 w-4 mr-2" />LLM</TabsTrigger>
          <TabsTrigger value="nodes" className="py-2.5"><Server className="h-4 w-4 mr-2" />FreeSWITCH Nodes</TabsTrigger>
          <TabsTrigger value="telephony" className="py-2.5"><Phone className="h-4 w-4 mr-2" />Telephony / SIP</TabsTrigger>
          <TabsTrigger value="storage" className="py-2.5"><Database className="h-4 w-4 mr-2" />Storage</TabsTrigger>
        </TabsList>

        {/* Speech Tab */}
        <SpeechSettingsTab
          settings={settings}
          updateMutation={updateMutation}
          testProvider={testProvider}
          testingProvider={testingProvider}
          testResults={testResults}
          isDemoMode={isDemoMode}
          toast={toast}
        />

        {/* LLM Tab */}
        <LlmSettingsTab
          settings={settings}
          updateMutation={updateMutation}
          testProvider={testProvider}
          testingProvider={testingProvider}
          testResults={testResults}
          isDemoMode={isDemoMode}
          toast={toast}
          isOrModelsLoading={isOrModelsLoading}
          orSearch={orSearch}
          setOrSearch={setOrSearch}
          orModels={orModels}
        />

        {/* FreeSWITCH Nodes Tab */}
        <NodesSettingsTab
          refetchNodes={refetchNodes}
          isDemoMode={isDemoMode}
          toast={toast}
          handleOpenAddDialog={handleOpenAddDialog}
          nodes={nodes}
          handleOpenEditDialog={handleOpenEditDialog}
          deleteNodeMutation={deleteNodeMutation}
        />
        {/* Telephony Tab */}
        <TelephonySettingsTab
          selectedSipProvider={selectedSipProvider}
          setSelectedSipProvider={setSelectedSipProvider}
          sipTemplates={sipTemplates}
          handleCopy={handleCopy}
          copiedText={copiedText}
          dialplanXml={dialplanXml}
        />

        {/* Storage Tab */}
        <TabsContent value="storage" className="space-y-4 mt-4">
          <StorageSettingsTab />
        </TabsContent>
      </Tabs>

      {/* FreeSWITCH Node Dialog */}
      <FreeSwitchNodeDialog
        isNodeDialogOpen={isNodeDialogOpen}
        setIsNodeDialogOpen={setIsNodeDialogOpen}
        editingNode={editingNode}
        nodeName={nodeName}
        setNodeName={setNodeName}
        eslHost={eslHost}
        setEslHost={setEslHost}
        eslPort={eslPort}
        setEslPort={setEslPort}
        eslPassword={eslPassword}
        setEslPassword={setEslPassword}
        sipHost={sipHost}
        setSipHost={setSipHost}
        sipPort={sipPort}
        setSipPort={setSipPort}
        wsPort={wsPort}
        setWsPort={setWsPort}
        maxCalls={maxCalls}
        setMaxCalls={setMaxCalls}
        nodeStatus={nodeStatus}
        setNodeStatus={setNodeStatus}
        handleSaveNode={handleSaveNode}
        saveNodeMutation={saveNodeMutation}
        isDemoMode={isDemoMode}
      />

      {/* SIP Gateway Dialog */}
      <SipGatewayDialog
        isGatewayDialogOpen={isGatewayDialogOpen}
        setIsGatewayDialogOpen={setIsGatewayDialogOpen}
        editingGateway={editingGateway}
        gwName={gwName}
        setGwName={setGwName}
        gwUsername={gwUsername}
        setGwUsername={setGwUsername}
        gwPassword={gwPassword}
        setGwPassword={setGwPassword}
        gwProxy={gwProxy}
        setGwProxy={setGwProxy}
        gwRegister={gwRegister}
        setGwRegister={setGwRegister}
        gwCallerIdInFrom={gwCallerIdInFrom}
        setGwCallerIdInFrom={setGwCallerIdInFrom}
        handleSaveGateway={handleSaveGateway}
        saveGatewayMutation={saveGatewayMutation}
        isDemoMode={isDemoMode}
      />
    </div>
  );
}
