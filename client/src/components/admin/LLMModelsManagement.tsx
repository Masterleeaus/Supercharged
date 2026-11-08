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
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Brain, CheckCircle2, XCircle } from "lucide-react";
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

import { useTranslation } from "react-i18next";

interface LLMModel {
  id: string;
  modelId: string;
  name: string;
  provider: string;
  tier: 'free' | 'pro';
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export default function LLMModelsManagement() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const { data: models, isLoading } = useQuery<LLMModel[]>({
    queryKey: ["/api/admin/llm-models"],
  });

  const updateModel = useMutation({
    mutationFn: async ({ modelId, updates }: { modelId: string; updates: Partial<LLMModel> }) => {
      return apiRequest("PATCH", `/api/admin/llm-models/${modelId}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/llm-models"] });
      toast({ title: t("adminDashboard.llmModels.modelUpdated") });
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.llmModels.updateFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const handleTierChange = (modelId: string, tier: 'free' | 'pro') => {
    updateModel.mutate({ modelId, updates: { tier } });
  };

  const handleActiveToggle = (modelId: string, isActive: boolean) => {
    updateModel.mutate({ modelId, updates: { isActive } });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5" />
            {t("adminDashboard.llmModels.title")}
          </CardTitle>
          <CardDescription>
            {t("adminDashboard.llmModels.description")}
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

  const freeModels = models?.filter(m => m.tier === 'free') || [];
  const proModels = models?.filter(m => m.tier === 'pro') || [];
  const sortedModels = [...freeModels, ...proModels];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Brain className="h-5 w-5" />
          {t("adminDashboard.llmModels.title")}
        </CardTitle>
        <CardDescription>
          {t("adminDashboard.llmModels.fullDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Summary stats */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 border rounded-md">
              <div className="text-sm text-muted-foreground">{t("adminDashboard.llmModels.totalModels")}</div>
              <div className="text-2xl font-bold">{models?.length || 0}</div>
            </div>
            <div className="p-4 border rounded-md">
              <div className="text-sm text-muted-foreground">{t("adminDashboard.llmModels.freeTier")}</div>
              <div className="text-2xl font-bold text-green-600">{freeModels.length}</div>
            </div>
            <div className="p-4 border rounded-md">
              <div className="text-sm text-muted-foreground">{t("adminDashboard.llmModels.proTier")}</div>
              <div className="text-2xl font-bold text-blue-600">{proModels.length}</div>
            </div>
          </div>

          {/* Models table */}
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("adminDashboard.llmModels.columns.modelName")}</TableHead>
                  <TableHead>{t("adminDashboard.llmModels.columns.provider")}</TableHead>
                  <TableHead>{t("adminDashboard.llmModels.columns.modelId")}</TableHead>
                  <TableHead>{t("adminDashboard.llmModels.columns.tier")}</TableHead>
                  <TableHead>{t("adminDashboard.llmModels.columns.status")}</TableHead>
                  <TableHead>{t("adminDashboard.llmModels.columns.active")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedModels.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                      {t("adminDashboard.llmModels.noModels")}
                    </TableCell>
                  </TableRow>
                ) : (
                  (Array.isArray(sortedModels) ? sortedModels : []).map((model) => (
                    <TableRow key={model.id} data-testid={`row-model-${model.id}`}>
                      <TableCell className="font-medium" data-testid={`text-model-name-${model.id}`}>
                        {model.name}
                      </TableCell>
                      <TableCell data-testid={`text-model-provider-${model.id}`}>
                        {model.provider}
                      </TableCell>
                      <TableCell className="font-mono text-sm text-muted-foreground" data-testid={`text-model-id-${model.id}`}>
                        {model.modelId}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={model.tier}
                          onValueChange={(value: 'free' | 'pro') => handleTierChange(model.id, value)}
                          disabled={updateModel.isPending}
                        >
                          <SelectTrigger
                            className="w-32"
                            data-testid={`select-tier-${model.id}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="free">
                              <Badge variant="secondary" className="text-green-600 border-green-600">
                                {t("adminDashboard.users.plans.free")}
                              </Badge>
                            </SelectItem>
                            <SelectItem value="pro">
                              <Badge variant="secondary" className="text-blue-600 border-blue-600">
                                {t("adminDashboard.users.plans.pro")}
                              </Badge>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        {model.isActive ? (
                          <Badge variant="secondary" className="text-green-600 border-green-600" data-testid={`badge-active-${model.id}`}>  
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            {t("common.active")}
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-red-600 border-red-600" data-testid={`badge-inactive-${model.id}`}>    
                            <XCircle className="h-3 w-3 mr-1" />
                            {t("common.inactive")}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={model.isActive}
                          onCheckedChange={(checked) => handleActiveToggle(model.id, checked)}
                          disabled={updateModel.isPending}
                          data-testid={`switch-active-${model.id}`}
                        />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="text-sm text-muted-foreground space-y-1">
            <p><strong>{t("adminDashboard.llmModels.note")}</strong></p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>{t("adminDashboard.llmModels.notes.freeAccess")}</li>
              <li>{t("adminDashboard.llmModels.notes.proAccess")}</li>
              <li>{t("adminDashboard.llmModels.notes.inactiveHidden")}</li>
              <li>{t("adminDashboard.llmModels.notes.downgradeSwitch")}</li>
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
