import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Loader2, Brain, CheckCircle2, XCircle, Plus, Pencil, Trash2, RefreshCw, Activity, AlertTriangle } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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

interface OpenAICredential {
  id: string;
  name: string;
  modelTier: 'free' | 'pro';
  maxConcurrency: number;
  currentLoad: number;
  totalAssignedAgents: number;
  maxAgentsThreshold: number;
  isActive: boolean;
  healthStatus: 'healthy' | 'degraded' | 'unhealthy';
  lastHealthCheck: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PoolStats {
  totalKeys: number;
  totalCapacity: number;
  totalLoad: number;
  availableCapacity: number;
  utilizationPercent: number;
  totalAgents: number;
  totalUsers: number;
  byTier: {
    free: { keys: number; capacity: number; load: number; available: number };
    pro: { keys: number; capacity: number; load: number; available: number };
  };
}

const addCredentialSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  apiKey: z.string().min(1, "API key is required").regex(/^sk-/, "API key must start with 'sk-'"),
  modelTier: z.enum(["free", "pro"]),
  maxConcurrency: z.coerce.number().int().min(1).max(1000),
  maxAgentsThreshold: z.coerce.number().int().min(1).max(10000),
});

const editCredentialSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  modelTier: z.enum(["free", "pro"]),
  maxConcurrency: z.coerce.number().int().min(1).max(1000),
  maxAgentsThreshold: z.coerce.number().int().min(1).max(10000),
});

type AddCredentialFormData = z.infer<typeof addCredentialSchema>;
type EditCredentialFormData = z.infer<typeof editCredentialSchema>;

export default function OpenAIPoolManagement() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedCredential, setSelectedCredential] = useState<OpenAICredential | null>(null);

  const addForm = useForm<AddCredentialFormData>({
    resolver: zodResolver(addCredentialSchema),
    defaultValues: {
      name: "",
      apiKey: "",
      modelTier: "free",
      maxConcurrency: 50,
      maxAgentsThreshold: 100,
    },
  });

  const editForm = useForm<EditCredentialFormData>({
    resolver: zodResolver(editCredentialSchema),
    defaultValues: {
      name: "",
      modelTier: "free",
      maxConcurrency: 50,
      maxAgentsThreshold: 100,
    },
  });

  const { data: stats, isLoading: statsLoading } = useQuery<PoolStats>({
    queryKey: ["/api/plivo/admin/openai/pool/stats"],
  });

  const { data: credentials, isLoading: credentialsLoading } = useQuery<OpenAICredential[]>({
    queryKey: ["/api/plivo/admin/openai/credentials"],
  });

  const addCredential = useMutation({
    mutationFn: async (data: AddCredentialFormData) => {
      return apiRequest("POST", "/api/plivo/admin/openai/credentials", {
        name: data.name,
        apiKey: data.apiKey,
        modelTier: data.modelTier,
        maxConcurrency: parseInt(String(data.maxConcurrency), 10),
        maxAgentsThreshold: parseInt(String(data.maxAgentsThreshold), 10),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/openai/credentials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/openai/pool/stats"] });
      toast({ title: t("adminDashboard.openaiPool.toasts.addSuccess") });
      setAddDialogOpen(false);
      addForm.reset();
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.openaiPool.toasts.addFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const updateCredential = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: EditCredentialFormData }) => {
      return apiRequest("PATCH", `/api/plivo/admin/openai/credentials/${id}`, {
        name: updates.name,
        modelTier: updates.modelTier,
        maxConcurrency: parseInt(String(updates.maxConcurrency), 10),
        maxAgentsThreshold: parseInt(String(updates.maxAgentsThreshold), 10),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/openai/credentials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/openai/pool/stats"] });
      toast({ title: t("adminDashboard.openaiPool.toasts.updateSuccess") });
      setEditDialogOpen(false);
      setSelectedCredential(null);
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.openaiPool.toasts.updateFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const deleteCredential = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/plivo/admin/openai/credentials/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/openai/credentials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/openai/pool/stats"] });
      toast({ title: t("adminDashboard.openaiPool.toasts.deleteSuccess") });
      setDeleteDialogOpen(false);
      setSelectedCredential(null);
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.openaiPool.toasts.deleteFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const endpoint = isActive ? "activate" : "deactivate";
      return apiRequest("POST", `/api/plivo/admin/openai/credentials/${id}/${endpoint}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/openai/credentials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/openai/pool/stats"] });
      toast({ title: t("adminDashboard.openaiPool.toasts.statusUpdated") });
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.openaiPool.toasts.statusUpdateFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const runHealthCheck = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/plivo/admin/openai/pool/health-check");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/openai/credentials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/openai/pool/stats"] });
      toast({ title: t("adminDashboard.openaiPool.toasts.healthCheckComplete") });
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.openaiPool.toasts.healthCheckFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const recalculateCounts = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/plivo/admin/openai/pool/recalculate");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/openai/credentials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/openai/pool/stats"] });
      toast({ title: t("adminDashboard.openaiPool.toasts.recalculated") });
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.openaiPool.toasts.recalculationFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const openEditDialog = (credential: OpenAICredential) => {
    setSelectedCredential(credential);
    editForm.reset({
      name: credential.name,
      modelTier: credential.modelTier,
      maxConcurrency: credential.maxConcurrency,
      maxAgentsThreshold: credential.maxAgentsThreshold,
    });
    setEditDialogOpen(true);
  };

  const openAddDialog = () => {
    addForm.reset({
      name: "",
      apiKey: "",
      modelTier: "free",
      maxConcurrency: 50,
      maxAgentsThreshold: 100,
    });
    setAddDialogOpen(true);
  };

  const getHealthBadge = (status: string) => {
    switch (status) {
      case 'healthy':
        return (
          <Badge variant="secondary" className="text-green-600 border-green-600">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            {t("adminDashboard.openaiPool.healthStatus.healthy")}
          </Badge>
        );
      case 'degraded':
        return (
          <Badge variant="secondary" className="text-yellow-600 border-yellow-600">
            <AlertTriangle className="h-3 w-3 mr-1" />
            {t("adminDashboard.openaiPool.healthStatus.degraded")}
          </Badge>
        );
      case 'unhealthy':
        return (
          <Badge variant="secondary" className="text-red-600 border-red-600">
            <XCircle className="h-3 w-3 mr-1" />
            {t("adminDashboard.openaiPool.healthStatus.unhealthy")}
          </Badge>
        );
      default:
        return (
          <Badge variant="secondary" className="text-muted-foreground">
            {t("adminDashboard.openaiPool.healthStatus.unknown")}
          </Badge>
        );
    }
  };

  const isLoading = statsLoading || credentialsLoading;
  const anyMutationPending = addCredential.isPending || updateCredential.isPending ||
    deleteCredential.isPending || toggleActive.isPending;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5" />
            {t("adminDashboard.openaiPool.title")}
          </CardTitle>
          <CardDescription>
            {t("adminDashboard.openaiPool.description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5" />
              {t("adminDashboard.openaiPool.title")}
            </CardTitle>
            <CardDescription>
              {t("adminDashboard.openaiPool.description")}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => runHealthCheck.mutate()}
              disabled={runHealthCheck.isPending || anyMutationPending}
              data-testid="button-health-check"
            >
              {runHealthCheck.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Activity className="h-4 w-4 mr-2" />
              )}
              {t("adminDashboard.openaiPool.healthCheck")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => recalculateCounts.mutate()}
              disabled={recalculateCounts.isPending || anyMutationPending}
              data-testid="button-recalculate"
            >
              {recalculateCounts.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              {t("adminDashboard.openaiPool.recalculate")}
            </Button>
            <Button
              size="sm"
              onClick={openAddDialog}
              disabled={anyMutationPending}
              data-testid="button-add-credential"
            >
              <Plus className="h-4 w-4 mr-2" />
              {t("adminDashboard.openaiPool.addKey")}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 border rounded-md">
              <div className="text-sm text-muted-foreground">{t("adminDashboard.openaiPool.stats.totalKeys")}</div>
              <div className="text-2xl font-bold" data-testid="stat-total-keys">
                {stats?.totalKeys || 0}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("adminDashboard.openaiPool.stats.activeKeys", { count: stats?.totalKeys || 0 })}
              </div>
            </div>
            <div className="p-4 border rounded-md">
              <div className="text-sm text-muted-foreground">{t("adminDashboard.openaiPool.stats.totalCapacity")}</div>
              <div className="text-2xl font-bold" data-testid="stat-capacity">
                {stats?.totalCapacity || 0}
              </div>
            </div>
            <div className="p-4 border rounded-md">
              <div className="text-sm text-muted-foreground">{t("adminDashboard.openaiPool.stats.currentLoad")}</div>
              <div className="text-2xl font-bold" data-testid="stat-load">
                {stats?.totalLoad || 0}
              </div>
            </div>
            <div className="p-4 border rounded-md">
              <div className="text-sm text-muted-foreground">{t("adminDashboard.openaiPool.stats.utilization")}</div>
              <div className="text-2xl font-bold" data-testid="stat-utilization">
                {stats?.utilizationPercent?.toFixed(1) || 0}%
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 border rounded-md">
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="secondary" className="text-green-600 border-green-600">{t("adminDashboard.openaiPool.stats.freeTier")}</Badge>
                <span className="text-sm text-muted-foreground">{t("adminDashboard.openaiPool.stats.tier")}</span>
              </div>
              <div className="text-lg font-semibold">
                {t("adminDashboard.openaiPool.stats.keys", { count: stats?.byTier?.free?.keys || 0 })}
              </div>
              <div className="text-sm text-muted-foreground">
                {t("adminDashboard.openaiPool.stats.capacityLoad", {
                  capacity: stats?.byTier?.free?.capacity || 0,
                  load: stats?.byTier?.free?.load || 0
                })}
              </div>
            </div>
            <div className="p-4 border rounded-md">
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="secondary" className="text-blue-600 border-blue-600">{t("adminDashboard.openaiPool.stats.proTier")}</Badge>
                <span className="text-sm text-muted-foreground">{t("adminDashboard.openaiPool.stats.tier")}</span>
              </div>
              <div className="text-lg font-semibold">
                {t("adminDashboard.openaiPool.stats.keys", { count: stats?.byTier?.pro?.keys || 0 })}
              </div>
              <div className="text-sm text-muted-foreground">
                {t("adminDashboard.openaiPool.stats.capacityLoad", {
                  capacity: stats?.byTier?.pro?.capacity || 0,
                  load: stats?.byTier?.pro?.load || 0
                })}
              </div>
            </div>
          </div>

          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("adminDashboard.openaiPool.table.name")}</TableHead>
                  <TableHead>{t("adminDashboard.openaiPool.table.modelTier")}</TableHead>
                  <TableHead>{t("adminDashboard.openaiPool.table.maxConcurrency")}</TableHead>
                  <TableHead>{t("adminDashboard.openaiPool.table.currentLoad")}</TableHead>
                  <TableHead>{t("adminDashboard.openaiPool.table.assignedAgents")}</TableHead>
                  <TableHead>{t("adminDashboard.openaiPool.table.health")}</TableHead>
                  <TableHead>{t("adminDashboard.openaiPool.table.active")}</TableHead>
                  <TableHead className="text-right">{t("adminDashboard.openaiPool.table.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!credentials || credentials.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      {t("adminDashboard.openaiPool.table.empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  (Array.isArray(credentials) ? credentials : []).map((cred) => (
                    <TableRow key={cred.id} data-testid={`row-credential-${cred.id}`}>
                      <TableCell className="font-medium" data-testid={`text-name-${cred.id}`}>
                        {cred.name}
                      </TableCell>
                      <TableCell>
                        {cred.modelTier === 'free' ? (
                          <Badge variant="secondary" className="text-green-600 border-green-600">
                            {t("adminDashboard.openaiPool.stats.freeTier")}
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-blue-600 border-blue-600">
                            {t("adminDashboard.openaiPool.stats.proTier")}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell data-testid={`text-concurrency-${cred.id}`}>
                        {cred.maxConcurrency}
                      </TableCell>
                      <TableCell data-testid={`text-load-${cred.id}`}>
                        {cred.currentLoad}
                      </TableCell>
                      <TableCell data-testid={`text-agents-${cred.id}`}>
                        {cred.totalAssignedAgents} / {cred.maxAgentsThreshold}
                      </TableCell>
                      <TableCell data-testid={`badge-health-${cred.id}`}>
                        {getHealthBadge(cred.healthStatus)}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={cred.isActive}
                          onCheckedChange={(checked) =>
                            toggleActive.mutate({ id: cred.id, isActive: checked })
                          }
                          disabled={toggleActive.isPending || anyMutationPending}
                          data-testid={`switch-active-${cred.id}`}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEditDialog(cred)}
                            disabled={anyMutationPending}
                            data-testid={`button-edit-${cred.id}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setSelectedCredential(cred);
                              setDeleteDialogOpen(true);
                            }}
                            disabled={anyMutationPending}
                            data-testid={`button-delete-${cred.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardContent>

      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("adminDashboard.openaiPool.addDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("adminDashboard.openaiPool.addDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <Form {...addForm}>
            <form onSubmit={addForm.handleSubmit((data) => addCredential.mutate(data))} className="space-y-4 py-4">
              <FormField
                control={addForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("adminDashboard.openaiPool.addDialog.nameLabel")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder={t("adminDashboard.openaiPool.addDialog.namePlaceholder")}
                        data-testid="input-name"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={addForm.control}
                name="apiKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("adminDashboard.openaiPool.addDialog.apiKeyLabel")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="password"
                        placeholder={t("adminDashboard.openaiPool.addDialog.apiKeyPlaceholder")}
                        data-testid="input-api-key"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={addForm.control}
                name="modelTier"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("adminDashboard.openaiPool.addDialog.modelTierLabel")}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger data-testid="select-tier">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="free">{t("adminDashboard.openaiPool.addDialog.freeOption")}</SelectItem>
                        <SelectItem value="pro">{t("adminDashboard.openaiPool.addDialog.proOption")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={addForm.control}
                  name="maxConcurrency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("adminDashboard.openaiPool.addDialog.maxConcurrencyLabel")}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          data-testid="input-max-concurrency"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={addForm.control}
                  name="maxAgentsThreshold"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("adminDashboard.openaiPool.addDialog.maxAgentsThresholdLabel")}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          data-testid="input-max-agents"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAddDialogOpen(false)}>
                  {t("adminDashboard.openaiPool.cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={addCredential.isPending}
                  data-testid="button-save-credential"
                >
                  {addCredential.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {t("adminDashboard.openaiPool.addDialog.submit")}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("adminDashboard.openaiPool.editDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("adminDashboard.openaiPool.editDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit((data) => {
              if (selectedCredential) {
                updateCredential.mutate({ id: selectedCredential.id, updates: data });
              }
            })} className="space-y-4 py-4">
              <FormField
                control={editForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("adminDashboard.openaiPool.editDialog.nameLabel")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        data-testid="input-edit-name"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="modelTier"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("adminDashboard.openaiPool.editDialog.modelTierLabel")}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger data-testid="select-edit-tier">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="free">{t("adminDashboard.openaiPool.editDialog.freeOption")}</SelectItem>
                        <SelectItem value="pro">{t("adminDashboard.openaiPool.editDialog.proOption")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={editForm.control}
                  name="maxConcurrency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("adminDashboard.openaiPool.editDialog.maxConcurrencyLabel")}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          data-testid="input-edit-max-concurrency"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="maxAgentsThreshold"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("adminDashboard.openaiPool.editDialog.maxAgentsThresholdLabel")}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          data-testid="input-edit-max-agents"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditDialogOpen(false)}>
                  {t("adminDashboard.openaiPool.cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={updateCredential.isPending}
                  data-testid="button-update-credential"
                >
                  {updateCredential.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {t("adminDashboard.openaiPool.editDialog.submit")}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("adminDashboard.openaiPool.deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("adminDashboard.openaiPool.deleteDialog.description", { name: selectedCredential?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteCredential.isPending}>
              {t("adminDashboard.openaiPool.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (selectedCredential) {
                  deleteCredential.mutate(selectedCredential.id);
                }
              }}
              disabled={deleteCredential.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deleteCredential.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("adminDashboard.openaiPool.deleteDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}