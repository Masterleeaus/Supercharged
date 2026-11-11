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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Webhook, Copy } from "lucide-react";
import type { TFunction } from "i18next";

export interface PaymentRedirectUrlsCardProps {
  t: TFunction<"translation", undefined>;
  toast: ReturnType<typeof useToast>["toast"];
}

export function PaymentRedirectUrlsCard({ t, toast }: PaymentRedirectUrlsCardProps) {
  return (
    <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center gap-3">
            <Webhook className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">{t("adminDashboard.payments.redirectUrls.title")}</CardTitle>
              <CardDescription>{t("adminDashboard.payments.redirectUrls.description")}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 p-3 bg-muted/50 rounded-lg border">
              <Label className="text-xs font-medium text-muted-foreground">{t("adminDashboard.payments.redirectUrls.successLabel")}</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-sm font-mono text-foreground truncate bg-background px-2 py-1 rounded border">
                  {window.location.origin}/app/billing?success=true
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/app/billing?success=true`);
                    toast({ title: t("adminDashboard.payments.redirectUrls.copied"), description: t("adminDashboard.payments.redirectUrls.successUrlCopied") });
                  }}
                  data-testid="button-copy-success-url"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.redirectUrls.successHint")}</p>
            </div>
            <div className="space-y-2 p-3 bg-muted/50 rounded-lg border">
              <Label className="text-xs font-medium text-muted-foreground">{t("adminDashboard.payments.redirectUrls.cancelLabel")}</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-sm font-mono text-foreground truncate bg-background px-2 py-1 rounded border">
                  {window.location.origin}/app/billing?cancelled=true
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/app/billing?cancelled=true`);
                    toast({ title: t("adminDashboard.payments.redirectUrls.copied"), description: t("adminDashboard.payments.redirectUrls.cancelUrlCopied") });
                  }}
                  data-testid="button-copy-cancel-url"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.redirectUrls.cancelHint")}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("adminDashboard.payments.redirectUrls.note")}
          </p>
        </CardContent>
      </Card>
  );
}
