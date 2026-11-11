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
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, AlertTriangle } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TFunction } from "i18next";
import type { UseMutationResult } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";
import { Plan, MigrationState } from "@/components/admin/plan-management/shared";

export interface PlanMigrationDialogProps {
  migrationState: MigrationState;
  setMigrationState: Dispatch<SetStateAction<MigrationState>>;
  t: TFunction<"translation", undefined>;
  plans: Plan[];
  migrateUsers: UseMutationResult<any, any, { planId: string; targetPlanId: string; }, unknown>;
  deletePlan: UseMutationResult<any, any, string, unknown>;
}

export function PlanMigrationDialog({ migrationState, setMigrationState, t, plans, migrateUsers, deletePlan }: PlanMigrationDialogProps) {
  return (
    <AlertDialog open={!!migrationState} onOpenChange={(open) => !open && setMigrationState(null)}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              {t("adminDashboard.plans.migrationRequired")}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                <p>
                  {t("adminDashboard.plans.migrationRequiredDesc", { 
                    count: migrationState?.userCount || 0, 
                    plan: migrationState?.plan?.displayName 
                  })}
                </p>
                
                {/* Check if there are other plans available */}
                {plans && plans.filter(p => p.id !== migrationState?.plan?.id).length > 0 ? (
                  <div className="space-y-2">
                    <Label>{t("adminDashboard.plans.selectTargetPlan")}</Label>
                    <Select
                      value={migrationState?.targetPlanId || ''}
                      onValueChange={(value) => setMigrationState(prev => prev ? { ...prev, targetPlanId: value } : null)}
                    >
                      <SelectTrigger data-testid="select-migration-target">
                        <SelectValue placeholder={t("adminDashboard.plans.selectPlan")} />
                      </SelectTrigger>
                      <SelectContent>
                        {plans
                          .filter(p => p.id !== migrationState?.plan?.id)
                          .map(p => (
                            <SelectItem key={p.id} value={p.id} data-testid={`option-plan-${p.id}`}>
                              {p.displayName} (${Number(p.monthlyPrice).toFixed(2)}/mo)
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <div className="p-3 rounded-md bg-amber-500/10 border border-amber-500/20">
                    <p className="text-sm text-amber-600 dark:text-amber-400">
                      {t("adminDashboard.plans.noOtherPlansAvailable")}
                    </p>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={migrateUsers.isPending || deletePlan.isPending}>
              {t("common.cancel")}
            </AlertDialogCancel>
            {plans && plans.filter(p => p.id !== migrationState?.plan?.id).length > 0 && (
              <Button
                onClick={() => {
                  if (migrationState && migrationState.targetPlanId) {
                    migrateUsers.mutate({
                      planId: migrationState.plan.id,
                      targetPlanId: migrationState.targetPlanId
                    });
                  }
                }}
                disabled={!migrationState?.targetPlanId || migrateUsers.isPending || deletePlan.isPending}
                data-testid="button-migrate-and-delete"
              >
                {migrateUsers.isPending || deletePlan.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {t("adminDashboard.plans.migratingUsers")}
                  </>
                ) : (
                  t("adminDashboard.plans.migrateAndDelete")
                )}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
  );
}
