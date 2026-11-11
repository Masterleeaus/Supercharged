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
import { DollarSign, AlertTriangle } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";

export interface CurrencyChangeDialogProps {
  showCurrencyChangeDialog: boolean;
  setShowCurrencyChangeDialog: Dispatch<SetStateAction<boolean>>;
  t: TFunction<"translation", undefined>;
  stripeFormData: { stripe_secret_key: string; stripe_publishable_key: string; stripe_webhook_secret: string; stripe_currency: string; stripe_mode: string; };
  pendingCurrencyChange: string;
  cancelCurrencyChange: () => void;
  confirmCurrencyChange: () => void;
}

export function CurrencyChangeDialog({ showCurrencyChangeDialog, setShowCurrencyChangeDialog, t, stripeFormData, pendingCurrencyChange, cancelCurrencyChange, confirmCurrencyChange }: CurrencyChangeDialogProps) {
  return (
    <AlertDialog open={showCurrencyChangeDialog} onOpenChange={setShowCurrencyChangeDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              {t("adminDashboard.payments.changeCurrency.title")}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  {t("adminDashboard.payments.changeCurrency.body", { from: stripeFormData.stripe_currency, to: pendingCurrencyChange })}
                </p>
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3">
                  <p className="font-medium text-amber-600 dark:text-amber-400">
                    {t("adminDashboard.payments.changeCurrency.warningTitle")}
                  </p>
                  <p className="mt-1">
                    {t("adminDashboard.payments.changeCurrency.warningBody")}
                  </p>
                </div>
                <p>
                  {t("adminDashboard.payments.changeCurrency.note")}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelCurrencyChange}>{t("adminDashboard.payments.changeCurrency.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCurrencyChange}
              className="bg-amber-600 hover:bg-amber-700"
            >
              <DollarSign className="h-4 w-4 mr-2" />
              {t("adminDashboard.payments.changeCurrency.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
  );
}
