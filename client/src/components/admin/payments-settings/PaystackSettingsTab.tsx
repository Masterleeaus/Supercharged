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
import { ConnectionStatus, PAYSTACK_CURRENCIES } from "@/components/admin/payments-settings/shared";

export interface PaystackSettingsTabProps {
  t: TFunction<"translation", undefined>;
  isPaystackConfigured: any;
  paystackConnectionStatus: ConnectionStatus;
  settings: any;
  paystackFormData: { paystack_public_key: string; paystack_secret_key: string; paystack_webhook_secret: string; paystack_currency: string; };
  handlePaystackChange: (key: "paystack_public_key" | "paystack_secret_key" | "paystack_webhook_secret" | "paystack_currency", value: string) => void;
  showPaystackSecretKey: boolean;
  setShowPaystackSecretKey: Dispatch<SetStateAction<boolean>>;
  showPaystackWebhookSecret: boolean;
  setShowPaystackWebhookSecret: Dispatch<SetStateAction<boolean>>;
  toast: ReturnType<typeof useToast>["toast"];
  testPaystackConnectionMutation: UseMutationResult<any, any, void, unknown>;
  savePaystackSettings: () => Promise<void>;
  hasPaystackChanges: boolean;
  updateSettingMutation: UseMutationResult<{ key: string; data: any; }, any, { key: string; value: any; }, unknown>;
}

export function PaystackSettingsTab({ t, isPaystackConfigured, paystackConnectionStatus, settings, paystackFormData, handlePaystackChange, showPaystackSecretKey, setShowPaystackSecretKey, showPaystackWebhookSecret, setShowPaystackWebhookSecret, toast, testPaystackConnectionMutation, savePaystackSettings, hasPaystackChanges, updateSettingMutation }: PaystackSettingsTabProps) {
  return (
    <TabsContent value="paystack">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CreditCard className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <CardTitle>{t("adminDashboard.payments.paystack.title")}</CardTitle>
                    <CardDescription>{t("adminDashboard.payments.paystack.description")}</CardDescription>
                  </div>
                </div>
                {isPaystackConfigured && (
                  <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    {t("adminDashboard.payments.gatewayAvailability.configured")}
                  </Badge>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-6">
              {paystackConnectionStatus && (
                <Alert variant={paystackConnectionStatus.connected ? "default" : "destructive"}>
                  {paystackConnectionStatus.connected ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  <AlertDescription>
                    {paystackConnectionStatus.connected
                      ? t("adminDashboard.payments.paystack.connectionSuccess")
                      : paystackConnectionStatus.error || t("adminDashboard.payments.paystack.connectionFailed")
                    }
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="paystack_public_key">{t("adminDashboard.payments.paystack.publicKey")}</Label>
                    {settings?.paystack_public_key && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <Input
                    id="paystack_public_key"
                    type="text"
                    value={paystackFormData.paystack_public_key}
                    onChange={(e) => handlePaystackChange("paystack_public_key", e.target.value)}
                    placeholder="pk_test_..."
                    data-testid="input-paystack-public-key"
                  />
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paystack.publicKeyHint")}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="paystack_secret_key">{t("adminDashboard.payments.paystack.secretKey")}</Label>
                    {settings?.paystack_secret_key && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                    <Input
                      id="paystack_secret_key"
                      type={showPaystackSecretKey ? "text" : "password"}
                      value={paystackFormData.paystack_secret_key}
                      onChange={(e) => handlePaystackChange("paystack_secret_key", e.target.value)}
                      placeholder={settings?.paystack_secret_key ? "Enter new secret to replace existing..." : "Enter your secret key"}
                      className="border-0 shadow-none focus-visible:ring-0 flex-1"
                      data-testid="input-paystack-secret-key"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setShowPaystackSecretKey(!showPaystackSecretKey)}
                      data-testid="button-toggle-paystack-secret"
                    >
                      {showPaystackSecretKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paystack.secretKeyHint")}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="paystack_webhook_secret">{t("adminDashboard.payments.paystack.webhookSecret")}</Label>
                    {settings?.paystack_webhook_secret && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                    <Input
                      id="paystack_webhook_secret"
                      type={showPaystackWebhookSecret ? "text" : "password"}
                      value={paystackFormData.paystack_webhook_secret}
                      onChange={(e) => handlePaystackChange("paystack_webhook_secret", e.target.value)}
                      placeholder={settings?.paystack_webhook_secret ? "Enter new secret to replace existing..." : "Enter webhook secret"}
                      className="border-0 shadow-none focus-visible:ring-0 flex-1"
                      data-testid="input-paystack-webhook-secret"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setShowPaystackWebhookSecret(!showPaystackWebhookSecret)}
                      data-testid="button-toggle-paystack-webhook-secret"
                    >
                      {showPaystackWebhookSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paystack.webhookSecretHint")}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="paystack_currency">{t("adminDashboard.payments.paystack.currency")}</Label>
                  <Select
                    value={paystackFormData.paystack_currency}
                    onValueChange={(value) => handlePaystackChange("paystack_currency", value)}
                  >
                    <SelectTrigger data-testid="select-paystack-currency">
                      <SelectValue placeholder={t("adminDashboard.payments.stripe.selectCurrency")} />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYSTACK_CURRENCIES.map((currency) => (
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
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paystack.currencyHint")}</p>
                </div>

                <div className="space-y-2 p-4 bg-muted/50 rounded-lg border">
                  <div className="flex items-center gap-2">
                    <Webhook className="h-4 w-4 text-muted-foreground" />
                    <Label className="font-medium">{t("adminDashboard.payments.paystack.webhookUrl")}</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 bg-background rounded border text-sm font-mono break-all">
                      {window.location.origin}/api/paystack/webhook
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        navigator.clipboard.writeText(`${window.location.origin}/api/paystack/webhook`);
                        toast({
                          title: t("adminDashboard.payments.redirectUrls.copied"),
                          description: t("adminDashboard.payments.paystack.webhookCopied"),
                        });
                      }}
                      data-testid="button-copy-paystack-webhook"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="space-y-2 mt-3">
                    <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paystack.webhookUrlHint")}</p>
                    <p className="text-xs text-muted-foreground font-medium">{t("adminDashboard.payments.paystack.enableEvents")}</p>
                    <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                      <li>charge.success</li>
                      <li>subscription.create</li>
                      <li>subscription.disable</li>
                      <li>subscription.not_renew</li>
                    </ul>
                  </div>
                </div>
              </div>

              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {t("adminDashboard.payments.paystack.alert")}
                </AlertDescription>
              </Alert>
            </CardContent>

            <CardFooter className="flex justify-between gap-2 flex-wrap">
              <Button
                variant="outline"
                onClick={() => testPaystackConnectionMutation.mutate()}
                disabled={testPaystackConnectionMutation.isPending}
                data-testid="button-test-paystack"
              >
                {testPaystackConnectionMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <TestTube className="h-4 w-4 mr-2" />
                )}
                {t("adminDashboard.payments.testConnection")}
              </Button>
              <Button
                onClick={savePaystackSettings}
                disabled={!hasPaystackChanges || updateSettingMutation.isPending}
                data-testid="button-save-paystack"
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
