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
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type { TFunction } from "i18next";
import type { UseMutationResult } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";
import { Agent } from "@/pages/agents/shared";

export interface AgentDeleteDialogProps {
  deletingAgent: Agent;
  setDeletingAgent: Dispatch<SetStateAction<Agent>>;
  t: TFunction<"translation", undefined>;
  deleteMutation: UseMutationResult<any, any, string, unknown>;
}

export function AgentDeleteDialog({ deletingAgent, setDeletingAgent, t, deleteMutation }: AgentDeleteDialogProps) {
  return (
    <AlertDialog open={!!deletingAgent} onOpenChange={() => setDeletingAgent(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('agents.delete.title')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('agents.delete.description', { name: deletingAgent?.name })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deletingAgent && deleteMutation.mutate(deletingAgent.id)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {t('common.delete')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
  );
}
