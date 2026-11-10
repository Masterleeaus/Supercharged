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
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { CreditCard, Save, Loader2, CheckCircle, AlertCircle, TestTube, Eye, EyeOff, Webhook, Copy } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TFunction } from "i18next";
import type { UseMutationResult } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";
import { ConnectionStatus, PAYPAL_CURRENCIES } from "@/components/admin/payments-settings/shared";

export interface PaypalSettingsTabProps {
  t: TFunction<"translation", undefined>;
  isPaypalConfigured: any;
  paypalConnectionStatus: ConnectionStatus;
  settings: any;
  paypalFormData: { paypal_client_id: string; paypal_client_secret: string; paypal_webhook_id: string; paypal_mode: string; paypal_currency: string; };
  handlePaypalChange: (key: "paypal_client_id" | "paypal_client_secret" | "paypal_webhook_id" | "paypal_mode" | "paypal_currency", value: string) => void;
  showPaypalClientSecret: boolean;
  setShowPaypalClientSecret: Dispatch<SetStateAction<boolean>>;
  toast: ReturnType<typeof useToast>["toast"];
  setupPaypalWebhookMutation: UseMutationResult<any, any, void, unknown>;
  testPaypalConnectionMutation: UseMutationResult<any, any, void, unknown>;
  savePaypalSettings: () => Promise<void>;
  hasPaypalChanges: boolean;
  updateSettingMutation: UseMutationResult<{ key: string; data: any; }, any, { key: string; value: any; }, unknown>;
}

export function PaypalSettingsTab({ t, isPaypalConfigured, paypalConnectionStatus, settings, paypalFormData, handlePaypalChange, showPaypalClientSecret, setShowPaypalClientSecret, toast, setupPaypalWebhookMutation, testPaypalConnectionMutation, savePaypalSettings, hasPaypalChanges, updateSettingMutation }: PaypalSettingsTabProps) {
  return (
    <TabsContent value="paypal">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CreditCard className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <CardTitle>{t("adminDashboard.payments.paypal.title")}</CardTitle>
                    <CardDescription>{t("adminDashboard.payments.paypal.description")}</CardDescription>
                  </div>
                </div>
                {isPaypalConfigured && (
                  <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    {t("adminDashboard.payments.gatewayAvailability.configured")}
                  </Badge>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-6">
              {paypalConnectionStatus && (
                <Alert variant={paypalConnectionStatus.connected ? "default" : "destructive"}>
                  {paypalConnectionStatus.connected ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  <AlertDescription>
                    {paypalConnectionStatus.connected ? (
                      <div className="space-y-1">
                        <p>{t("adminDashboard.payments.paypal.connectionSuccess")}</p>
                        {paypalConnectionStatus.mode && (
                          <p className="text-sm text-muted-foreground">
                            {t("adminDashboard.payments.mode")}: <strong>{paypalConnectionStatus.mode.toUpperCase()}</strong>
                          </p>
                        )}
                      </div>
                    ) : (
                      paypalConnectionStatus.error || t("adminDashboard.payments.paypal.connectionFailed")
                    )}
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="paypal_client_id">{t("adminDashboard.payments.paypal.clientId")}</Label>
                    {settings?.paypal_client_id && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <Input
                    id="paypal_client_id"
                    type="text"
                    value={paypalFormData.paypal_client_id}
                    onChange={(e) => handlePaypalChange("paypal_client_id", e.target.value)}
                    placeholder="Enter your PayPal Client ID"
                    data-testid="input-paypal-client-id"
                  />
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paypal.clientIdHint")}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="paypal_client_secret">{t("adminDashboard.payments.paypal.clientSecret")}</Label>
                    {settings?.paypal_client_secret && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                    <Input
                      id="paypal_client_secret"
                      type={showPaypalClientSecret ? "text" : "password"}
                      value={paypalFormData.paypal_client_secret}
                      onChange={(e) => handlePaypalChange("paypal_client_secret", e.target.value)}
                      placeholder={settings?.paypal_client_secret ? "Enter new secret to replace existing..." : "Enter your client secret"}
                      className="border-0 shadow-none focus-visible:ring-0 flex-1"
                      data-testid="input-paypal-client-secret"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setShowPaypalClientSecret(!showPaypalClientSecret)}
                      data-testid="button-toggle-paypal-secret"
                    >
                      {showPaypalClientSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paypal.clientSecretHint")}</p>
                </div>

                <div className="space-y-2 p-4 bg-muted/50 rounded-lg border">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Webhook className="h-4 w-4 text-muted-foreground" />
                      <Label className="font-medium">{t("adminDashboard.payments.paypal.webhookConfig")}</Label>
                    </div>
                    {settings?.paypal_webhook_id && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>

                  {settings?.paypal_webhook_id ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-2 bg-background rounded border text-sm font-mono break-all">
                          {window.location.origin}/api/paypal/webhook
                        </code>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => {
                            navigator.clipboard.writeText(`${window.location.origin}/api/paypal/webhook`);
                            toast({
                              title: t("adminDashboard.payments.redirectUrls.copied"),
                              description: t("adminDashboard.payments.paypal.webhookCopied"),
                            });
                          }}
                          data-testid="button-copy-paypal-webhook"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t("adminDashboard.payments.paypal.webhookId", { id: settings.paypal_webhook_id })}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setupPaypalWebhookMutation.mutate()}
                        disabled={setupPaypalWebhookMutation.isPending || !isPaypalConfigured}
                        data-testid="button-reconfigure-paypal-webhook"
                      >
                        {setupPaypalWebhookMutation.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Webhook className="h-4 w-4 mr-2" />
                        )}
                        {t("adminDashboard.payments.paypal.reconfigure")}
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        {t("adminDashboard.payments.paypal.webhookSetupInstructions")}
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-2 bg-background rounded border text-sm font-mono break-all">
                          {window.location.origin}/api/paypal/webhook
                        </code>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => {
                            navigator.clipboard.writeText(`${window.location.origin}/api/paypal/webhook`);
                            toast({
                              title: t("adminDashboard.payments.redirectUrls.copied"),
                              description: t("adminDashboard.payments.paypal.webhookCopied"),
                            });
                          }}
                          data-testid="button-copy-paypal-webhook"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      <Button
                        type="button"
                        onClick={() => setupPaypalWebhookMutation.mutate()}
                        disabled={setupPaypalWebhookMutation.isPending || !isPaypalConfigured}
                        data-testid="button-setup-paypal-webhook"
                      >
                        {setupPaypalWebhookMutation.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Webhook className="h-4 w-4 mr-2" />
                        )}
                        {t("adminDashboard.payments.paypal.setupAutomatically")}
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        {t("adminDashboard.payments.paypal.setupNote")}
                      </p>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="paypal_currency">{t("adminDashboard.payments.paypal.currency")}</Label>
                    <Select
                      value={paypalFormData.paypal_currency}
                      onValueChange={(value) => handlePaypalChange("paypal_currency", value)}
                    >
                      <SelectTrigger data-testid="select-paypal-currency">
                        <SelectValue placeholder={t("adminDashboard.payments.stripe.selectCurrency")} />
                      </SelectTrigger>
                      <SelectContent>
                        {PAYPAL_CURRENCIES.map((currency) => (
                          <SelectItem key={currency.code} value={currency.code}>
                            <div className="flex items-center gap-2">
                              <span className="font-mono">{currency.code}</span>
                              <span className="text-muted-foreground">({currency.symbol})</span>
                              <span className="text-xs text-muted-foreground">{currency.name}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paypal.currencyHint")}</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="paypal_mode">{t("adminDashboard.payments.paypal.mode")}</Label>
                    <Select
                      value={paypalFormData.paypal_mode}
                      onValueChange={(value) => handlePaypalChange("paypal_mode", value)}
                    >
                      <SelectTrigger data-testid="select-paypal-mode">
                        <SelectValue placeholder={t("adminDashboard.payments.selectMode")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sandbox">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20">
                              {t("adminDashboard.payments.paypal.sandbox")}
                            </Badge>
                            <span className="text-muted-foreground">{t("adminDashboard.payments.paypal.testMode")}</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="live">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                              {t("adminDashboard.payments.paypal.live")}
                            </Badge>
                            <span className="text-muted-foreground">{t("adminDashboard.payments.paypal.productionMode")}</span>
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </CardContent>

            <CardFooter className="flex justify-between gap-2 flex-wrap">
              <Button
                variant="outline"
                onClick={() => testPaypalConnectionMutation.mutate()}
                disabled={testPaypalConnectionMutation.isPending}
                data-testid="button-test-paypal"
              >
                {testPaypalConnectionMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <TestTube className="h-4 w-4 mr-2" />
                )}
                {t("adminDashboard.payments.testConnection")}
              </Button>
              <Button
                onClick={savePaypalSettings}
                disabled={!hasPaypalChanges || updateSettingMutation.isPending}
                data-testid="button-save-paypal"
              >
                {updateSettingMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                {t("common.saveChanges")}
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>
  );
}
