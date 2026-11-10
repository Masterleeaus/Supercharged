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
import { Loader2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type { TFunction } from "i18next";
import type { UseMutationResult } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";
import { Plan } from "@/components/admin/plan-management/shared";

export interface PlanDeleteDialogProps {
  deletingPlan: Plan;
  setDeletingPlan: Dispatch<SetStateAction<Plan>>;
  t: TFunction<"translation", undefined>;
  deletePlan: UseMutationResult<any, any, string, unknown>;
}

export function PlanDeleteDialog({ deletingPlan, setDeletingPlan, t, deletePlan }: PlanDeleteDialogProps) {
  return (
    <AlertDialog open={!!deletingPlan} onOpenChange={(open) => !open && setDeletingPlan(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("adminDashboard.plans.deletePlan")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("adminDashboard.plans.deletePlanConfirm", { name: deletingPlan?.displayName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePlan.isPending}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingPlan && deletePlan.mutate(deletingPlan.id)}
              disabled={deletePlan.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletePlan.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t("common.deleting")}
                </>
              ) : (
                t("adminDashboard.plans.deletePlan")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
  );
}
