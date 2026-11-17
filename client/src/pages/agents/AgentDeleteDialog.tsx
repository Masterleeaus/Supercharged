/**
 * ============================================================
 * © 2025 Titan Zero Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 * Copyright (c) Titan Zero.
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
  deleteMutation: UseMutationResult<unknown, Error, string, unknown>;
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
