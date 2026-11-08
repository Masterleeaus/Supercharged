/**
 * UserSipGatewaysTab
 *
 * Shown as a tab in /app/phone-numbers.
 * Allows each user to manage their own SIP gateways (credentials)
 * and manually add custom phone numbers linked to those gateways.
 */

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDemoMode } from "@/components/DemoModeBanner";
import {
  Server,
  Plus,
  Trash2,
  Edit,
  Phone,
  CheckCircle,
  Circle,
  Loader2,
  RefreshCw,
  Shield,
  Globe,
  KeyRound,
  Zap,
  User,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
}

interface UserSipGateway {
  id: string;
  name: string;
  username: string;
  password: string;
  proxy: string;
  register: boolean;
  caller_id_in_from: boolean;
  is_active: boolean;
  created_at: string;
}

interface UserSipPhoneNumber {
  id: string;
  phone_number: string;
  label: string | null;
  gateway_id: string | null;
  gateway_name: string | null;
  gateway_proxy: string | null;
  agent_id: string | null;
  is_active: boolean;
  created_at: string;
}

// ─── Empty Gateway Form ───────────────────────────────────────────────────────

const emptyGatewayForm = () => ({
  name: "",
  username: "",
  password: "",
  proxy: "",
  register: false,
  callerIdInFrom: true,
});

// ─── Component ────────────────────────────────────────────────────────────────

export default function UserSipGatewaysTab() {
  const { toast } = useToast();
  const { isDemoMode } = useDemoMode();

  // ── Gateway dialogs ──
  const [gatewayDialogOpen, setGatewayDialogOpen] = useState(false);
  const [editingGateway, setEditingGateway] = useState<UserSipGateway | null>(null);
  const [gatewayDeleteTarget, setGatewayDeleteTarget] = useState<UserSipGateway | null>(null);
  const [gwForm, setGwForm] = useState(emptyGatewayForm());

  // ── Phone number dialogs ──
  const [phoneDialogOpen, setPhoneDialogOpen] = useState(false);
  const [editingPhone, setEditingPhone] = useState<UserSipPhoneNumber | null>(null);
  const [phoneDeleteTarget, setPhoneDeleteTarget] = useState<UserSipPhoneNumber | null>(null);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneLabel, setPhoneLabel] = useState("");
  const [phoneGatewayId, setPhoneGatewayId] = useState<string>("none");
  const [phoneAgentId, setPhoneAgentId] = useState<string>("none");

  // ── Queries ──
  const { data: gatewaysData, isLoading: gatewaysLoading, refetch: refetchGateways } = useQuery<{ success: boolean; data: UserSipGateway[] }>({
    queryKey: ["/api/user/sip-gateways"],
  });
  const gateways = gatewaysData?.data || [];

  const { data: phonesData, isLoading: phonesLoading, refetch: refetchPhones } = useQuery<{ success: boolean; data: UserSipPhoneNumber[] }>({
    queryKey: ["/api/user/sip-phone-numbers"],
  });
  const phones = phonesData?.data || [];

  const { data: agentsData } = useQuery<Agent[]>({
    queryKey: ["/api/agents"],
  });
  const agents = agentsData || [];

  // ── Gateway mutations ──
  const saveGatewayMutation = useMutation({
    mutationFn: async (payload: typeof gwForm) => {
      if (editingGateway) {
        const res = await apiRequest("PUT", `/api/user/sip-gateways/${editingGateway.id}`, payload);
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/user/sip-gateways", payload);
        return res.json();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/sip-gateways"] });
      setGatewayDialogOpen(false);
      setEditingGateway(null);
      setGwForm(emptyGatewayForm());
      toast({
        title: editingGateway ? "Gateway updated" : "Gateway added",
        description: editingGateway
          ? "Your Custom Voice Engine gateway has been updated."
          : "Your new Custom Voice Engine gateway has been added.",
      });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message || "Failed to save gateway", variant: "destructive" });
    },
  });

  const deleteGatewayMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/user/sip-gateways/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/sip-gateways"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/sip-phone-numbers"] });
      setGatewayDeleteTarget(null);
      toast({ title: "Gateway deleted" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const activateGatewayMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/user/sip-gateways/${id}/activate`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/sip-gateways"] });
      toast({ title: "Gateway activated", description: "This gateway is now your active Custom Voice Engine gateway." });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // ── Phone mutations ──
  const savePhoneMutation = useMutation({
    mutationFn: async (payload: { phoneNumber: string; label?: string; gatewayId?: string; agentId?: string }) => {
      if (editingPhone) {
        const res = await apiRequest("PUT", `/api/user/sip-phone-numbers/${editingPhone.id}`, {
          label: payload.label,
          gatewayId: payload.gatewayId === "none" ? null : payload.gatewayId,
          agentId: payload.agentId === "none" ? null : payload.agentId,
        });
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/user/sip-phone-numbers", {
          phoneNumber: payload.phoneNumber,
          label: payload.label,
          gatewayId: payload.gatewayId === "none" ? null : payload.gatewayId,
          agentId: payload.agentId === "none" ? null : payload.agentId,
        });
        return res.json();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/sip-phone-numbers"] });
      setPhoneDialogOpen(false);
      setEditingPhone(null);
      setPhoneNumber("");
      setPhoneLabel("");
      setPhoneGatewayId("none");
      setPhoneAgentId("none");
      toast({
        title: editingPhone ? "Phone number updated" : "Phone number imported",
        description: editingPhone
          ? "Phone number details have been updated."
          : "Your phone number has been imported.",
      });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message || "Failed to save phone number", variant: "destructive" });
    },
  });

  const deletePhoneMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/user/sip-phone-numbers/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/sip-phone-numbers"] });
      setPhoneDeleteTarget(null);
      toast({ title: "Phone number removed" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // ── Handlers ──
  const openAddGateway = () => {
    if (isDemoMode) {
      toast({ title: "Demo Mode Active", description: "Adding Custom Voice Engine gateways is disabled in demo mode.", variant: "destructive" });
      return;
    }
    setEditingGateway(null);
    setGwForm(emptyGatewayForm());
    setGatewayDialogOpen(true);
  };

  const openEditGateway = (gw: UserSipGateway) => {
    if (isDemoMode) {
      toast({ title: "Demo Mode Active", description: "Editing Custom Voice Engine gateways is disabled in demo mode.", variant: "destructive" });
      return;
    }
    setEditingGateway(gw);
    setGwForm({
      name: gw.name,
      username: gw.username,
      password: gw.password,
      proxy: gw.proxy,
      register: gw.register,
      callerIdInFrom: gw.caller_id_in_from,
    });
    setGatewayDialogOpen(true);
  };

  const openAddPhone = () => {
    if (isDemoMode) {
      toast({ title: "Demo Mode Active", description: "Importing phone numbers is disabled in demo mode.", variant: "destructive" });
      return;
    }
    setEditingPhone(null);
    setPhoneNumber("");
    setPhoneLabel("");
    setPhoneGatewayId(gateways.find(g => g.is_active)?.id || (gateways[0]?.id) || "none");
    setPhoneAgentId("none");
    setPhoneDialogOpen(true);
  };

  const openEditPhone = (phone: UserSipPhoneNumber) => {
    if (isDemoMode) {
      toast({ title: "Demo Mode Active", description: "Editing phone numbers is disabled in demo mode.", variant: "destructive" });
      return;
    }
    setEditingPhone(phone);
    setPhoneNumber(phone.phone_number);
    setPhoneLabel(phone.label || "");
    
    // Fallback to 'none' if the linked gateway is deleted or not in the user's list
    const hasGateway = gateways.some(g => g.id === phone.gateway_id);
    setPhoneGatewayId(hasGateway ? (phone.gateway_id || "none") : "none");
    
    setPhoneAgentId(phone.agent_id || "none");
    setPhoneDialogOpen(true);
  };

  const handleSaveGateway = () => {
    if (!gwForm.name.trim() || !gwForm.username.trim() || !gwForm.password.trim() || !gwForm.proxy.trim()) {
      toast({ title: "Validation error", description: "Name, Username, Password, and Proxy are all required.", variant: "destructive" });
      return;
    }
    saveGatewayMutation.mutate(gwForm);
  };

  const handleSavePhone = () => {
    if (!editingPhone && !phoneNumber.trim()) {
      toast({ title: "Validation error", description: "Phone number is required.", variant: "destructive" });
      return;
    }
    savePhoneMutation.mutate({
      phoneNumber: phoneNumber.trim(),
      label: phoneLabel.trim() || undefined,
      gatewayId: phoneGatewayId,
      agentId: phoneAgentId,
    });
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">

      {/* ── SIP Gateways Section ─────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-sm">
              <Server className="h-4.5 w-4.5 text-white h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Custom Voice Engine Gateways</h2>
              <p className="text-sm text-muted-foreground">Your Custom Voice Engine credentials for outbound calls</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetchGateways()}
              disabled={gatewaysLoading}
            >
              <RefreshCw className={`h-4 w-4 ${gatewaysLoading ? "animate-spin" : ""}`} />
            </Button>
            <Button size="sm" onClick={openAddGateway}>
              <Plus className="h-4 w-4 mr-1.5" />
              Add Custom Voice Engine Gateway
            </Button>
          </div>
        </div>

        {gatewaysLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2].map(i => (
              <Card key={i} className="p-6 animate-pulse">
                <div className="h-5 bg-muted rounded w-1/2 mb-3" />
                <div className="h-4 bg-muted rounded w-full mb-2" />
                <div className="h-4 bg-muted rounded w-3/4" />
              </Card>
            ))}
          </div>
        ) : gateways.length === 0 ? (
          <Card className="p-10 text-center border-dashed">
            <div className="mx-auto mb-4 h-14 w-14 rounded-2xl bg-gradient-to-br from-indigo-100 to-purple-100 dark:from-indigo-900/40 dark:to-purple-900/40 flex items-center justify-center">
              <Server className="h-7 w-7 text-indigo-500 dark:text-indigo-400" />
            </div>
            <h3 className="text-base font-semibold mb-1">No Custom Voice Engine Gateways Yet</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-xs mx-auto">
              Add your SIP trunk credentials to enable outbound calls through your own Custom Voice Engine.
            </p>
            <Button onClick={openAddGateway}>
              <Plus className="h-4 w-4 mr-2" />
              Add Your First Gateway
            </Button>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {gateways.map(gw => (
              <Card
                key={gw.id}
                className={`p-5 relative transition-all duration-200 ${gw.is_active ? "ring-2 ring-indigo-500/60 shadow-indigo-100 dark:shadow-indigo-900/20 shadow-md" : ""}`}
              >
                {/* Active ribbon */}
                {gw.is_active && (
                  <div className="absolute top-3 right-3">
                    <Badge className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-2 py-0.5 gap-1">
                      <Zap className="h-3 w-3" />
                      Active
                    </Badge>
                  </div>
                )}

                <div className="mb-3 pr-20">
                  <h3 className="font-semibold text-base truncate">{gw.name}</h3>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">{gw.proxy}</p>
                </div>

                <div className="space-y-1.5 text-sm">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <KeyRound className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="font-mono truncate">{gw.username}</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Globe className="h-3.5 w-3.5 flex-shrink-0" />
                    <span>{gw.register ? "SIP Registration" : "IP Authentication"}</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Shield className="h-3.5 w-3.5 flex-shrink-0" />
                    <span>Caller-ID in From: {gw.caller_id_in_from ? "Yes" : "No"}</span>
                  </div>
                </div>

                <div className="pt-4 mt-4 border-t flex gap-2">
                  {!gw.is_active && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-indigo-600 border-indigo-200 hover:bg-indigo-50 dark:hover:bg-indigo-900/20"
                      onClick={() => {
                        if (isDemoMode) {
                          toast({ title: "Demo Mode Active", description: "Activating gateways is disabled in demo mode.", variant: "destructive" });
                          return;
                        }
                        activateGatewayMutation.mutate(gw.id);
                      }}
                      disabled={activateGatewayMutation.isPending}
                    >
                      {activateGatewayMutation.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CheckCircle className="h-3.5 w-3.5 mr-1" />
                      )}
                      Set Active
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEditGateway(gw)}
                  >
                    <Edit className="h-3.5 w-3.5 mr-1" />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => setGatewayDeleteTarget(gw)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ── Custom SIP Phone Numbers Section ─────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center shadow-sm">
              <Phone className="h-5 w-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Phone Numbers</h2>
              <p className="text-sm text-muted-foreground">Phone numbers imported from your Custom Voice Engine gateways</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetchPhones()}
              disabled={phonesLoading}
            >
              <RefreshCw className={`h-4 w-4 ${phonesLoading ? "animate-spin" : ""}`} />
            </Button>
            <Button size="sm" onClick={openAddPhone}>
              <Plus className="h-4 w-4 mr-1.5" />
              Import Number
            </Button>
          </div>
        </div>

        {phonesLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2].map(i => (
              <Card key={i} className="p-6 animate-pulse">
                <div className="h-5 bg-muted rounded w-1/2 mb-3" />
                <div className="h-4 bg-muted rounded w-full mb-2" />
              </Card>
            ))}
          </div>
        ) : phones.length === 0 ? (
          <Card className="p-10 text-center border-dashed">
            <div className="mx-auto mb-4 h-14 w-14 rounded-2xl bg-gradient-to-br from-teal-100 to-emerald-100 dark:from-teal-900/40 dark:to-emerald-900/40 flex items-center justify-center">
              <Phone className="h-7 w-7 text-teal-500 dark:text-teal-400" />
            </div>
            <h3 className="text-base font-semibold mb-1">No Phone Numbers</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-xs mx-auto">
              Import phone numbers you own from your Custom Voice Engine gateway.
            </p>
            <Button onClick={openAddPhone} disabled={gateways.length === 0}>
              <Plus className="h-4 w-4 mr-2" />
              Import Number
            </Button>
            {gateways.length === 0 && (
              <p className="text-xs text-muted-foreground mt-3">Add a Custom Voice Engine Gateway first before importing phone numbers.</p>
            )}
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {phones.map(phone => (
              <Card key={phone.id} className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold font-mono text-base truncate">{phone.phone_number}</h3>
                    {phone.label && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{phone.label}</p>
                    )}
                  </div>
                  <Badge variant={phone.is_active ? "default" : "secondary"} className="ml-2 flex-shrink-0">
                    {phone.is_active ? "Active" : "Inactive"}
                  </Badge>
                </div>

                {phone.gateway_name ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Server className="h-3.5 w-3.5 flex-shrink-0 text-indigo-500" />
                    <span className="truncate">
                      Via <span className="font-medium text-foreground">{phone.gateway_name}</span>
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Circle className="h-3.5 w-3.5 flex-shrink-0" />
                    <span>No gateway linked</span>
                  </div>
                )}

                {phone.agent_id ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mt-2">
                    <User className="h-3.5 w-3.5 flex-shrink-0 text-teal-500" />
                    <span className="truncate">
                      Agent: <span className="font-medium text-foreground">{agents.find(a => a.id === phone.agent_id)?.name || "Assigned"}</span>
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mt-2">
                    <User className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <span>No agent assigned</span>
                  </div>
                )}

                <div className="pt-4 mt-4 border-t flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => openEditPhone(phone)}
                  >
                    <Edit className="h-3.5 w-3.5 mr-1" />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => setPhoneDeleteTarget(phone)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ══ Gateway Add/Edit Dialog ══════════════════════════════════════════ */}
      <Dialog open={gatewayDialogOpen} onOpenChange={open => { if (!open) { setGatewayDialogOpen(false); setEditingGateway(null); setGwForm(emptyGatewayForm()); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingGateway ? "Edit Custom Voice Engine Gateway" : "Add Custom Voice Engine Gateway"}</DialogTitle>
            <DialogDescription>
              Enter your Custom Voice Engine credentials from your VoIP provider.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="gw-name">Gateway Name <span className="text-destructive">*</span></Label>
              <Input
                id="gw-name"
                placeholder="e.g. My Twilio Gateway"
                value={gwForm.name}
                onChange={e => setGwForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>

            {/* Username */}
            <div className="space-y-1.5">
              <Label htmlFor="gw-username">SIP Username <span className="text-destructive">*</span></Label>
              <Input
                id="gw-username"
                placeholder="e.g. john@sip.example.com"
                value={gwForm.username}
                onChange={e => setGwForm(f => ({ ...f, username: e.target.value }))}
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <Label htmlFor="gw-password">SIP Password <span className="text-destructive">*</span></Label>
              <Input
                id="gw-password"
                type="password"
                placeholder="••••••••"
                value={gwForm.password}
                onChange={e => setGwForm(f => ({ ...f, password: e.target.value }))}
              />
            </div>

            {/* Proxy */}
            <div className="space-y-1.5">
              <Label htmlFor="gw-proxy">Proxy / SIP Host <span className="text-destructive">*</span></Label>
              <Input
                id="gw-proxy"
                placeholder="e.g. sip.twilio.com"
                value={gwForm.proxy}
                onChange={e => setGwForm(f => ({ ...f, proxy: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">The SIP server hostname or IP address.</p>
            </div>

            {/* Register */}
            <div className="flex items-center justify-between rounded-lg border p-3.5">
              <div>
                <p className="text-sm font-medium">SIP Registration</p>
                <p className="text-xs text-muted-foreground">Enable if your provider requires SIP REGISTER (most do)</p>
              </div>
              <Switch
                checked={gwForm.register}
                onCheckedChange={v => setGwForm(f => ({ ...f, register: v }))}
              />
            </div>

            {/* Caller ID in From */}
            <div className="flex items-center justify-between rounded-lg border p-3.5">
              <div>
                <p className="text-sm font-medium">Caller-ID in From Header</p>
                <p className="text-xs text-muted-foreground">Include phone number in SIP From header</p>
              </div>
              <Switch
                checked={gwForm.callerIdInFrom}
                onCheckedChange={v => setGwForm(f => ({ ...f, callerIdInFrom: v }))}
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setGatewayDialogOpen(false); setEditingGateway(null); setGwForm(emptyGatewayForm()); }}>
              Cancel
            </Button>
            <Button onClick={handleSaveGateway} disabled={saveGatewayMutation.isPending}>
              {saveGatewayMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingGateway ? "Save Changes" : "Add Gateway"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══ Phone Number Add/Edit Dialog ════════════════════════════════════ */}
      <Dialog open={phoneDialogOpen} onOpenChange={open => { if (!open) { setPhoneDialogOpen(false); setEditingPhone(null); setPhoneNumber(""); setPhoneLabel(""); setPhoneGatewayId("none"); setPhoneAgentId("none"); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingPhone ? "Edit Phone Number" : "Import Phone Number"}</DialogTitle>
            <DialogDescription>
              {editingPhone
                ? "Update the label or gateway link for this phone number."
                : "Import a phone number from your Custom Voice Engine gateway."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Phone Number (only for add) */}
            {!editingPhone && (
              <div className="space-y-1.5">
                <Label htmlFor="phone-number">Phone Number <span className="text-destructive">*</span></Label>
                <Input
                  id="phone-number"
                  placeholder="+1234567890"
                  value={phoneNumber}
                  onChange={e => setPhoneNumber(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Use E.164 format — start with + and country code.</p>
              </div>
            )}

            {/* Label */}
            <div className="space-y-1.5">
              <Label htmlFor="phone-label">Label (optional)</Label>
              <Input
                id="phone-label"
                placeholder="e.g. Sales Line, Support"
                value={phoneLabel}
                onChange={e => setPhoneLabel(e.target.value)}
              />
            </div>

            {/* Gateway link */}
            <div className="space-y-1.5">
              <Label>Link to Custom Voice Engine Gateway</Label>
              <Select value={phoneGatewayId} onValueChange={setPhoneGatewayId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select gateway (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— No gateway —</SelectItem>
                  {gateways.map(gw => (
                    <SelectItem key={gw.id} value={gw.id}>
                      {gw.name}
                      {gw.is_active ? " ★" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {gateways.length === 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Add a Custom Voice Engine Gateway first to link this number to one.
                </p>
              )}
            </div>

            {/* Agent link */}
            <div className="space-y-1.5">
              <Label>Link to AI Agent</Label>
              <Select value={phoneAgentId} onValueChange={setPhoneAgentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select agent (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— No agent —</SelectItem>
                  {agents.map(agent => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setPhoneDialogOpen(false); setEditingPhone(null); setPhoneNumber(""); setPhoneLabel(""); setPhoneGatewayId("none"); setPhoneAgentId("none"); }}>
              Cancel
            </Button>
            <Button onClick={handleSavePhone} disabled={savePhoneMutation.isPending}>
              {savePhoneMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingPhone ? "Save Changes" : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══ Gateway Delete Confirmation ══════════════════════════════════════ */}
      <AlertDialog open={!!gatewayDeleteTarget} onOpenChange={open => { if (!open) setGatewayDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Gateway</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{gatewayDeleteTarget?.name}</strong>? Phone numbers linked to this gateway will be unlinked. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => {
                if (isDemoMode) {
                  toast({ title: "Demo Mode Active", description: "Deleting is disabled in demo mode.", variant: "destructive" });
                  setGatewayDeleteTarget(null);
                  return;
                }
                gatewayDeleteTarget && deleteGatewayMutation.mutate(gatewayDeleteTarget.id);
              }}
              disabled={deleteGatewayMutation.isPending}
            >
              {deleteGatewayMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete Gateway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ══ Phone Delete Confirmation ════════════════════════════════════════ */}
      <AlertDialog open={!!phoneDeleteTarget} onOpenChange={open => { if (!open) setPhoneDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Phone Number</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove <strong>{phoneDeleteTarget?.phone_number}</strong> from your account? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => {
                if (isDemoMode) {
                  toast({ title: "Demo Mode Active", description: "Deleting is disabled in demo mode.", variant: "destructive" });
                  setPhoneDeleteTarget(null);
                  return;
                }
                phoneDeleteTarget && deletePhoneMutation.mutate(phoneDeleteTarget.id);
              }}
              disabled={deletePhoneMutation.isPending}
            >
              {deletePhoneMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
