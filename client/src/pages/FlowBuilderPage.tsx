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
import { useCallback, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState, Handle, type Node, type Connection, BackgroundVariant } from "@xyflow/react";
import { Button } from "@/components/ui/button";

import { Label } from "@/components/ui/label";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Save, Play, MessageSquare, HelpCircle, GitBranch, Calendar, FileText, Webhook, Phone, Clock, StopCircle, Plus, ArrowLeft, Info, Volume2, Mail, MessageCircle } from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useRoute, useLocation } from "wouter";
import { TestFlowDialog } from "@/components/TestFlowDialog";

import { nanoid } from "nanoid";

import { FlowNode, FlowEdge, nodeTypeColors } from "@/pages/flow-builder/types";
import { nodeTypes } from "@/pages/flow-builder/FlowNodeCard";
import { NodePropertiesPanel } from "@/pages/flow-builder/NodePropertiesPanel";

export default function FlowBuilderPage() {
  const { t } = useTranslation();
  const [, params] = useRoute<{ id: string }>("/app/flows/:id");
  const [, setLocation] = useLocation();
  const flowId = params?.id;

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [flowName, setFlowName] = useState(t("flows.flowNamePlaceholder"));
  const [flowDescription, setFlowDescription] = useState("");
  const [agentId, setAgentId] = useState<string>("");
  const [selectedNode, setSelectedNode] = useState<FlowNode | null>(null);
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [sheetsExpandedAppointment, setSheetsExpandedAppointment] = useState(false);
  const [sheetsExpandedForm, setSheetsExpandedForm] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Available node types for the sidebar (using translations)
  const availableNodeTypes = [
    { type: "message", label: t("flows.nodeTypes.message"), description: t("flows.nodeDescriptions.message"), icon: MessageSquare },
    { type: "question", label: t("flows.nodeTypes.question"), description: t("flows.nodeDescriptions.question"), icon: HelpCircle },
    { type: "condition", label: t("flows.nodeTypes.condition"), description: t("flows.nodeDescriptions.condition"), icon: GitBranch },
    { type: "appointment", label: t("flows.nodeTypes.appointment"), description: t("flows.nodeDescriptions.appointment"), icon: Calendar },
    { type: "form", label: t("flows.nodeTypes.form"), description: t("flows.nodeDescriptions.form"), icon: FileText },
    { type: "webhook", label: t("flows.nodeTypes.webhook"), description: t("flows.nodeDescriptions.webhook"), icon: Webhook },
    { type: "transfer", label: t("flows.nodeTypes.transfer"), description: t("flows.nodeDescriptions.transfer"), icon: Phone },
    { type: "delay", label: t("flows.nodeTypes.delay"), description: t("flows.nodeDescriptions.delay"), icon: Clock },
    { type: "play_audio", label: t("flows.nodeTypes.playAudio"), description: t("flows.nodeDescriptions.playAudio"), icon: Volume2 },
    { type: "send_email", label: t("flows.nodeTypes.sendEmail", "Send Email"), description: t("flows.nodeDescriptions.sendEmail", "Send an email"), icon: Mail },
    { type: "send_whatsapp", label: t("flows.nodeTypes.sendWhatsapp", "Send WhatsApp"), description: t("flows.nodeDescriptions.sendWhatsapp", "Send WhatsApp msg"), icon: MessageCircle },
    { type: "end", label: t("flows.nodeTypes.end"), description: t("flows.nodeDescriptions.end"), icon: StopCircle },
  ];

  // Fetch agents for selection
  const { data: agents, isError: agentsError } = useQuery<any[]>({
    queryKey: ["/api/agents"],
  });

  // Fetch all flows to check for agent assignments (prevent assigning one agent to multiple flows)
  const { data: allFlows } = useQuery<any[]>({
    queryKey: ["/api/flow-automation/flows"],
  });

  // Check if selected agent uses ElevenLabs engine (doesn't support audio playback)
  const selectedAgent = agents?.find((a: any) => a.id === agentId);
  const isElevenLabsEngine = selectedAgent?.telephonyProvider === 'twilio' ||
    selectedAgent?.telephonyProvider === 'elevenlabs-sip' ||
    !selectedAgent?.telephonyProvider; // Default is twilio (ElevenLabs)

  // Fetch forms for form node selection
  const { data: availableForms, isLoading: isLoadingForms, isError: formsError } = useQuery<Array<{
    id: string;
    name: string;
    description: string | null;
    fields?: Array<{
      id: string;
      question: string;
      fieldType: string;
      isRequired: boolean;
      order: number;
    }>;
  }>>({
    queryKey: ["/api/flow-automation/forms"],
  });

  const { data: emailTemplatesForFlow } = useQuery<any[]>({
    queryKey: ["/api/messaging/email-templates"],
    select: (res: any) => Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []),
  });

  const { data: metaWhatsAppSettings } = useQuery<any>({
    queryKey: ["/api/messaging/meta-whatsapp/settings"],
    select: (res: any) => res?.data || res,
  });

  const { data: whatswaySettings } = useQuery<any>({
    queryKey: ["/api/messaging/whatsway/settings"],
    select: (res: any) => res?.data || res,
  });

  const { data: metaTemplatesRaw } = useQuery<any[]>({
    queryKey: ["/api/messaging/meta-whatsapp/templates"],
    enabled: !!metaWhatsAppSettings?.isActive,
    select: (res: any) => Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []),
  });

  const { data: whatswayTemplates } = useQuery<any[]>({
    queryKey: ["/api/messaging/whatsway/templates"],
    enabled: !!whatswaySettings?.isActive,
    select: (res: any) => Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []),
  });

  const waTemplatesForFlow = (() => {
    if (metaWhatsAppSettings?.isActive && metaTemplatesRaw) {
      return metaTemplatesRaw.map((tmpl: any) => {
        const bodyComponent = (tmpl.components || []).find((c: any) => c.type === "BODY");
        const headerComponent = (tmpl.components || []).find((c: any) => c.type === "HEADER");
        const buttonsComponent = (tmpl.components || []).find((c: any) => c.type === "BUTTONS" || c.type === "buttons");
        return {
          name: tmpl.name,
          language: tmpl.language,
          body: bodyComponent?.text || "",
          status: tmpl.status,
          components: tmpl.components || [],
          header: headerComponent || null,
          buttons: buttonsComponent?.buttons || [],
        };
      });
    }
    if (whatswaySettings?.isActive && whatswayTemplates) {
      return whatswayTemplates;
    }
    return [];
  })();

  // Load existing flow if editing (not for new flows)
  const { data: flow, isError: flowError, isLoading: flowLoading } = useQuery<any>({
    queryKey: [`/api/flow-automation/flows/${flowId}`],
    enabled: !!flowId && flowId !== "new",
  });

  // Load flow data when fetched
  useEffect(() => {
    if (flow) {
      // Normalize nodes to ensure root-level type matches data.type (matching template format)
      const normalizedNodes = ((flow.nodes as FlowNode[]) || []).map((node) => ({
        ...node,
        type: node.data?.type || node.type, // Ensure type matches data.type
      }));
      setNodes(normalizedNodes);
      setEdges((flow.edges as FlowEdge[]) || []);
      setFlowName(flow.name);
      setFlowDescription(flow.description || "");
      setAgentId(flow.agentId || "");
    }
  }, [flow, setNodes, setEdges]);

  // Sync sheets expanded state when selected node changes
  useEffect(() => {
    if (selectedNode?.data.type === "appointment") {
      setSheetsExpandedAppointment(!!selectedNode.data.config?.googleSheetId);
    } else if (selectedNode?.data.type === "form") {
      setSheetsExpandedForm(!!selectedNode.data.config?.googleSheetId);
    }
  }, [selectedNode?.id]);

  // Handle connection creation with validation
  const onConnect = useCallback(
    (connection: Connection) => {
      // Prevent self-connections
      if (connection.source === connection.target) {
        toast({
          title: t("flows.toast.invalidConnection"),
          description: t("flows.toast.cannotConnectSelf"),
          variant: "destructive",
        });
        return;
      }

      // Add edge with ID immediately (required for state management)
      const edgeWithId = {
        ...connection,
        id: `edge-${connection.source}-${connection.target}${connection.sourceHandle ? `-${connection.sourceHandle}` : ''}`,
        animated: true,
      };

      // @ts-expect-error - xyflow's addEdge has overly strict animated type requirement
      setEdges((eds) => addEdge(edgeWithId, eds));
    },
    [setEdges, toast, t]
  );

  // Handle node click (single click to select)
  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node as FlowNode);
  }, []);

  // Save flow mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      // Ensure all edges have IDs (required by backend schema)
      const edgesWithIds = edges.map((edge) => ({
        ...edge,
        id: edge.id || `edge-${edge.source}-${edge.target}`,
      }));

      // Ensure nodes have correct format matching templates
      // Root-level type should match data.type (e.g., "message", "question")
      const nodesWithCorrectFormat = nodes.map((node) => ({
        ...node,
        type: node.data.type, // Use actual node type, not "custom"
      }));

      const flowData = {
        name: flowName,
        description: flowDescription,
        nodes: nodesWithCorrectFormat,
        edges: edgesWithIds,
        agentId: agentId || null,
        isActive: flow?.isActive ?? true,
      };

      const isNewFlow = !flowId || flowId === "new";
      const response = isNewFlow
        ? await apiRequest("POST", "/api/flow-automation/flows", flowData)
        : await apiRequest("PATCH", `/api/flow-automation/flows/${flowId}`, flowData);

      // Parse and return the JSON response so onSuccess gets the flow data with id
      const data = await response.json();
      return data;
    },
    onSuccess: (data: any) => {
      toast({
        title: t("flows.toast.saved"),
        description: t("flows.toast.savedDescription"),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/flow-automation/flows"] });

      const isNewFlow = !flowId || flowId === "new";

      // Invalidate the individual flow query to refresh the editor with latest data
      if (!isNewFlow) {
        queryClient.invalidateQueries({ queryKey: [`/api/flow-automation/flows/${flowId}`] });
      }

      // Navigate to edit mode if this was a new flow
      if (isNewFlow && data?.id) {
        setLocation(`/app/flows/${data.id}`);
      }
    },
    onError: (error: any) => {
      toast({
        title: t("flows.toast.saveError"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Add new node to canvas
  const addNode = (type: string) => {
    const nodeLabel = availableNodeTypes.find((n) => n.type === type)?.label || type;
    const newNode: FlowNode = {
      id: `node-${Date.now()}`,
      type: type, // Use actual node type to match template format (e.g., "message", "question")
      position: { x: 250, y: 50 + nodes.length * 100 },
      data: {
        type,
        label: nodeLabel,
        config: {
          type,
        },
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setSelectedNode(newNode);
  };

  // Update selected node configuration
  const updateNodeConfig = (config: any) => {
    if (!selectedNode) return;

    setNodes((nds) =>
      nds.map((node) =>
        node.id === selectedNode.id
          ? { ...node, data: { ...node.data, config: { ...node.data.config, ...config } } }
          : node
      )
    );

    // Update selected node state
    setSelectedNode((prev) =>
      prev ? { ...prev, data: { ...prev.data, config: { ...prev.data.config, ...config } } } : null
    );
  };

  // Delete selected node with smart reconnect.
  // If the deleted node sits in a straight line (exactly 1 incoming + 1 outgoing edge),
  // a new direct edge is created from the predecessor to the successor so the flow
  // stays connected. For branching nodes, plain deletion happens and a warning is shown.
  const deleteNode = () => {
    if (!selectedNode) return;

    setEdges((eds) => {
      const incoming = eds.filter((e) => e.target === selectedNode.id);
      const outgoing = eds.filter((e) => e.source === selectedNode.id);
      const otherEdges = eds.filter(
        (e) => e.source !== selectedNode.id && e.target !== selectedNode.id
      );

      if (incoming.length === 1 && outgoing.length === 1) {
        // Linear pass-through node — bridge predecessor → successor
        const bridgeEdge = {
          ...outgoing[0],
          id: `e-${nanoid(8)}`,
          source: incoming[0].source,
          sourceHandle: incoming[0].sourceHandle ?? null,
          target: outgoing[0].target,
          targetHandle: outgoing[0].targetHandle ?? null,
        };
        return [...otherEdges, bridgeEdge];
      }

      // Branching node — just remove all connected edges and warn
      if (incoming.length + outgoing.length > 0) {
        toast({
          title: t("flow.reconnectionNeeded", "Flow reconnection needed"),
          description: t(
            "flow.reconnectionNeededDesc",
            "Please manually reconnect the remaining nodes."
          ),
          variant: "destructive",
        });
      }

      return otherEdges;
    });

    setNodes((nds) => nds.filter((node) => node.id !== selectedNode.id));
    setSelectedNode(null);
  };

  // Get available nodes for dropdowns
  const getAvailableNodes = () => {
    return nodes.map((node) => ({
      id: node.id,
      label: `${node.data.label} (${node.id.substring(node.id.length - 8)})`,
    }));
  };

  return (
    <div className="flex h-screen w-full">
      {/* Sidebar - Node Types with Teal Theme */}
      <div className="w-60 flex-shrink-0 flex flex-col border-r bg-gradient-to-b from-brand/5 via-brand/3 to-background dark:from-brand/10 dark:via-brand/5 dark:to-background">
        {/* Sidebar Header */}
        <div className="p-4 border-b border-brand/20 dark:border-brand/20">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLocation("/app/flows")}
            className="mb-3 -ml-2"
            data-testid="button-back"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t("flows.backToFlows")}
          </Button>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-brand to-brand/90 flex items-center justify-center shadow-lg shadow-brand/25">
              <GitBranch className="h-5 w-5 text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-sm text-foreground" data-testid="text-node-types-title">{t("flows.title")}</h3>
              <p className="text-xs text-brand/70">
                {t("flows.subtitle")}
              </p>
            </div>
          </div>
        </div>

        {/* Node Types */}
        <div className="flex-1 overflow-y-auto p-4">
          <div className="text-xs font-medium text-brand mb-3 uppercase tracking-wider">
            {t("flows.addNodes")}
          </div>
          <div className="space-y-2">
            {availableNodeTypes.map((nodeType) => {
              const Icon = nodeType.icon;
              const colors = nodeTypeColors[nodeType.type as keyof typeof nodeTypeColors] || nodeTypeColors.message;
              return (
                <Button
                  key={nodeType.type}
                  variant="outline"
                  className="w-full justify-start gap-2 h-auto py-2.5 hover-elevate active-elevate-2 border-l-4 bg-white/50 dark:bg-white/5"
                  style={{ borderLeftColor: colors.handle }}
                  onClick={() => addNode(nodeType.type)}
                  data-testid={`button-add-${nodeType.type}-node`}
                >
                  <div
                    className={`p-1.5 rounded bg-gradient-to-br ${colors.bg}`}
                  >
                    <Icon className="w-3.5 h-3.5 text-white" />
                  </div>
                  <div className="flex-1 text-left min-w-0">
                    <div className="font-medium text-sm truncate">{nodeType.label}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {nodeType.description}
                    </div>
                  </div>
                  <Plus className="w-4 h-4 flex-shrink-0 text-brand" />
                </Button>
              );
            })}
          </div>
        </div>

        {/* Sidebar Footer Tip */}
        <div className="p-4 border-t border-brand/20 dark:border-brand/20 bg-brand/5 dark:bg-brand/10">
          <p className="text-xs text-brand">
            {t("flows.tipClickNodes")}
          </p>
        </div>
      </div>

      {/* Main Canvas */}
      <div className="flex-1 flex flex-col">
        {/* Top Toolbar with Teal Theme */}
        <div className="border-b px-4 py-3 flex items-center justify-between gap-4 bg-gradient-to-r from-brand/5 via-brand/3 to-background dark:from-brand/10 dark:via-brand/5 dark:to-background">
          <div className="flex-1">
            <input
              type="text"
              value={flowName}
              onChange={(e) => setFlowName(e.target.value)}
              className="text-lg font-semibold bg-transparent border-none outline-none w-full"
              placeholder={t("flows.flowName")}
              data-testid="input-flow-name"
            />
            <input
              type="text"
              value={flowDescription}
              onChange={(e) => setFlowDescription(e.target.value)}
              className="text-sm text-muted-foreground bg-transparent border-none outline-none w-full mt-1"
              placeholder={t("flows.flowDescriptionPlaceholder")}
              data-testid="input-flow-description"
            />
          </div>

          <div className="flex items-center gap-2">
            {/* Agent Selection */}
            <div className="min-w-[200px]">
              <Label className="text-xs text-muted-foreground mb-1">{t("flows.voiceAgent")}</Label>
              <Select value={agentId || "none"} onValueChange={(val) => setAgentId(val === "none" ? "" : val)}>
                <SelectTrigger className="h-8 text-sm" data-testid="select-agent">
                  <SelectValue placeholder={t("flows.selectAgent")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("flows.noAgent")}</SelectItem>
                  {agents?.filter((a: any) => a.type !== 'incoming' || a.telephonyProvider === 'custom-voice-engine').map((agent: any) => {
                    // Check if this agent is assigned to another flow
                    const otherFlow = allFlows?.find((f: any) => f.agentId === agent.id && f.id !== flowId);

                    return (
                      <SelectItem
                        key={agent.id}
                        value={agent.id}
                      >
                        {agent.name}
                        {otherFlow ? ` (In use by: ${otherFlow.name})` : ''}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <TooltipProvider>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" data-testid="button-help">
                    <Info className="w-4 h-4 mr-2" />
                    {t("flows.help")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-96" align="end">
                  <div className="space-y-4">
                    <div>
                      <h4 className="font-semibold text-sm mb-2">{t("flows.helpContent.howToBuild")}</h4>
                      <p className="text-xs text-muted-foreground">
                        {t("flows.helpContent.howToBuildDesc")}
                      </p>
                    </div>

                    <div>
                      <h4 className="font-semibold text-sm mb-2">{t("flows.helpContent.questionVariables")}</h4>
                      <p className="text-xs text-muted-foreground mb-2">
                        {t("flows.helpContent.questionVariablesDesc")}
                      </p>
                      <div className="bg-muted/50 p-2 rounded text-xs font-mono">
                        Question: "Can I transfer your call?"<br />
                        Variable: transfer_consent
                      </div>
                    </div>

                    <div>
                      <h4 className="font-semibold text-sm mb-2">{t("flows.helpContent.usingConditions")}</h4>
                      <p className="text-xs text-muted-foreground mb-2">
                        {t("flows.helpContent.usingConditionsDesc")}
                      </p>
                      <div className="bg-muted/50 p-2 rounded text-xs font-mono space-y-1">
                        <div>transfer_consent == "yes"</div>
                        <div>age &gt; 18</div>
                        <div>response contains "help"</div>
                      </div>
                    </div>

                    <div>
                      <h4 className="font-semibold text-sm mb-2">{t("flows.helpContent.callTransferExample")}</h4>
                      <p className="text-xs text-muted-foreground">
                        {t("flows.helpContent.callTransferExampleDesc")}
                      </p>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </TooltipProvider>

            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (!flowId) {
                  toast({
                    title: t("flows.toast.saveFirst"),
                    description: t("flows.toast.saveFirstDescription"),
                    variant: "destructive",
                  });
                  return;
                }
                setTestDialogOpen(true);
              }}
              disabled={!flowId}
              className="border-brand/20 dark:border-brand/20 hover:bg-brand/5 dark:hover:bg-brand/10"
              data-testid="button-test-flow"
            >
              <Play className="w-4 h-4 mr-2 text-brand" />
              {t("flows.test")}
            </Button>
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="bg-gradient-to-r from-brand to-brand/90 hover:from-brand hover:to-brand/90 text-brand-foreground shadow-md shadow-brand/25"
              data-testid="button-save-flow"
            >
              <Save className="w-4 h-4 mr-2" />
              {saveMutation.isPending ? t("flows.saving") : t("flows.save")}
            </Button>
          </div>
        </div>

        {/* React Flow Canvas */}
        <div className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            fitView
            snapToGrid
            snapGrid={[15, 15]}
            defaultEdgeOptions={{
              animated: true,
              style: {
                strokeWidth: 2.5,
                stroke: 'url(#edge-gradient)',
              }
            }}
            data-testid="flow-canvas"
          >
            <svg width="0" height="0">
              <defs>
                <linearGradient id="edge-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#14b8a6" />
                  <stop offset="50%" stopColor="#06b6d4" />
                  <stop offset="100%" stopColor="#0891b2" />
                </linearGradient>
              </defs>
            </svg>
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1.5}
              className="bg-gradient-to-br from-brand/5 via-brand/3 to-white dark:from-brand/10 dark:via-brand/5 dark:to-background"
            />
            <Controls className="!bg-background/90 !backdrop-blur !border !border-border !shadow-lg" />
            <MiniMap
              className="!bg-background/90 !backdrop-blur !border !border-border !shadow-lg"
              nodeColor={(node) => {
                const type = node.data?.type as keyof typeof nodeTypeColors;
                const colors = nodeTypeColors[type];
                if (colors) {
                  return colors.handle;
                }
                return "hsl(var(--primary))";
              }}
              maskColor="rgba(0, 0, 0, 0.1)"
            />
          </ReactFlow>

          <NodePropertiesPanel
            agentId={agentId}
            selectedNode={selectedNode}
            setSelectedNode={setSelectedNode}
            sheetsExpandedAppointment={sheetsExpandedAppointment}
            setSheetsExpandedAppointment={setSheetsExpandedAppointment}
            sheetsExpandedForm={sheetsExpandedForm}
            setSheetsExpandedForm={setSheetsExpandedForm}
            availableForms={availableForms}
            isLoadingForms={isLoadingForms}
            emailTemplatesForFlow={emailTemplatesForFlow}
            waTemplatesForFlow={waTemplatesForFlow}
            isElevenLabsEngine={isElevenLabsEngine}
            updateNodeConfig={updateNodeConfig}
            deleteNode={deleteNode}
            getAvailableNodes={getAvailableNodes}
          />
        </div>
      </div>

      {/* Test Flow Dialog */}
      {flowId && (
        <TestFlowDialog
          open={testDialogOpen}
          onOpenChange={setTestDialogOpen}
          flowId={flowId}
          flowName={flowName}
        />
      )}
    </div>
  );
}