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
import { ConnectionStatus, YOOKASSA_CURRENCIES } from "@/components/admin/payments-settings/shared";

export interface YookassaSettingsTabProps {
  t: TFunction<"translation", undefined>;
  isYookassaConfigured: any;
  yookassaConnectionStatus: ConnectionStatus;
  settings: any;
  yookassaFormData: { yookassa_shop_id: string; yookassa_secret_key: string; yookassa_webhook_secret: string; yookassa_currency: string; };
  handleYookassaChange: (key: "yookassa_shop_id" | "yookassa_secret_key" | "yookassa_webhook_secret" | "yookassa_currency", value: string) => void;
  showYookassaSecretKey: boolean;
  setShowYookassaSecretKey: Dispatch<SetStateAction<boolean>>;
  showYookassaWebhookSecret: boolean;
  setShowYookassaWebhookSecret: Dispatch<SetStateAction<boolean>>;
  toast: ReturnType<typeof useToast>["toast"];
  testYookassaConnectionMutation: UseMutationResult<any, any, void, unknown>;
  saveYookassaSettings: () => Promise<void>;
  hasYookassaChanges: boolean;
  updateSettingMutation: UseMutationResult<{ key: string; data: any; }, any, { key: string; value: any; }, unknown>;
}

export function YookassaSettingsTab({ t, isYookassaConfigured, yookassaConnectionStatus, settings, yookassaFormData, handleYookassaChange, showYookassaSecretKey, setShowYookassaSecretKey, showYookassaWebhookSecret, setShowYookassaWebhookSecret, toast, testYookassaConnectionMutation, saveYookassaSettings, hasYookassaChanges, updateSettingMutation }: YookassaSettingsTabProps) {
  return (
    <TabsContent value="yookassa">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CreditCard className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <CardTitle>{t("adminDashboard.payments.yookassa.title")}</CardTitle>
                    <CardDescription>{t("adminDashboard.payments.yookassa.description")}</CardDescription>
                  </div>
                </div>
                {isYookassaConfigured && (
                  <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    {t("adminDashboard.payments.gatewayAvailability.configured")}
                  </Badge>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-6">
              {yookassaConnectionStatus && (
                <Alert variant={yookassaConnectionStatus.connected ? "default" : "destructive"}>
                  {yookassaConnectionStatus.connected ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  <AlertDescription>
                    {yookassaConnectionStatus.connected ? (
                      t("adminDashboard.payments.yookassa.connectionSuccess")
                    ) : (
                      yookassaConnectionStatus.error
                    )}
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="yookassa_shop_id">{t("adminDashboard.payments.yookassa.shopId")}</Label>
                    {settings?.yookassa_shop_id && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <Input
                    id="yookassa_shop_id"
                    type="text"
                    value={yookassaFormData.yookassa_shop_id}
                    onChange={(e) => handleYookassaChange("yookassa_shop_id", e.target.value)}
                    placeholder="Enter your Shop ID"
                    data-testid="input-yookassa-shop-id"
                  />
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.yookassa.shopIdHint")}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="yookassa_secret_key">{t("adminDashboard.payments.yookassa.secretKey")}</Label>
                    {settings?.yookassa_secret_key && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                    <Input
                      id="yookassa_secret_key"
                      type={showYookassaSecretKey ? "text" : "password"}
                      value={yookassaFormData.yookassa_secret_key}
                      onChange={(e) => handleYookassaChange("yookassa_secret_key", e.target.value)}
                      placeholder={settings?.yookassa_secret_key ? "Enter new secret key to replace..." : "Enter your secret key"}
                      className="border-0 shadow-none focus-visible:ring-0 flex-1"
                      data-testid="input-yookassa-secret-key"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setShowYookassaSecretKey(!showYookassaSecretKey)}
                      data-testid="button-toggle-yookassa-secret-key"
                    >
                      {showYookassaSecretKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.yookassa.secretKeyHint")}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="yookassa_webhook_secret">{t("adminDashboard.payments.yookassa.webhookSecret")}</Label>
                    {settings?.yookassa_webhook_secret && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                    <Input
                      id="yookassa_webhook_secret"
                      type={showYookassaWebhookSecret ? "text" : "password"}
                      value={yookassaFormData.yookassa_webhook_secret}
                      onChange={(e) => handleYookassaChange("yookassa_webhook_secret", e.target.value)}
                      placeholder={settings?.yookassa_webhook_secret ? "Enter new secret to replace..." : "Enter webhook secret"}
                      className="border-0 shadow-none focus-visible:ring-0 flex-1"
                      data-testid="input-yookassa-webhook-secret"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setShowYookassaWebhookSecret(!showYookassaWebhookSecret)}
                      data-testid="button-toggle-yookassa-webhook-secret"
                    >
                      {showYookassaWebhookSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.yookassa.webhookSecretHint")}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="yookassa_currency">{t("adminDashboard.payments.yookassa.currency")}</Label>
                  <Select
                    value={yookassaFormData.yookassa_currency}
                    onValueChange={(value) => handleYookassaChange("yookassa_currency", value)}
                  >
                    <SelectTrigger data-testid="select-yookassa-currency">
                      <SelectValue placeholder={t("adminDashboard.payments.stripe.selectCurrency")} />
                    </SelectTrigger>
                    <SelectContent>
                      {YOOKASSA_CURRENCIES.map((currency) => (
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
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.yookassa.currencyHint")}</p>
                </div>

                <div className="space-y-2 p-4 bg-muted/50 rounded-lg border col-span-1 md:col-span-2">
                  <div className="flex items-center gap-2">
                    <Webhook className="h-4 w-4 text-muted-foreground" />
                    <Label className="font-medium">{t("adminDashboard.payments.yookassa.webhookConfig")}</Label>
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      {t("adminDashboard.payments.yookassa.webhookSetupInstructions")}
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 px-3 py-2 bg-background rounded border text-sm font-mono break-all">
                        {window.location.origin}/api/yookassa/webhook
                      </code>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => {
                          navigator.clipboard.writeText(`${window.location.origin}/api/yookassa/webhook`);
                          toast({
                            title: t("adminDashboard.payments.redirectUrls.copied"),
                            description: t("adminDashboard.payments.yookassa.webhookCopied"),
                          });
                        }}
                        data-testid="button-copy-yookassa-webhook"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {t("adminDashboard.payments.yookassa.alert")}
                </AlertDescription>
              </Alert>
            </CardContent>

            <CardFooter className="flex justify-between gap-2 flex-wrap">
              <Button
                variant="outline"
                onClick={() => testYookassaConnectionMutation.mutate()}
                disabled={testYookassaConnectionMutation.isPending}
                data-testid="button-test-yookassa"
              >
                {testYookassaConnectionMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <TestTube className="h-4 w-4 mr-2" />
                )}
                {t("adminDashboard.payments.testConnection")}
              </Button>
              <Button
                onClick={saveYookassaSettings}
                disabled={!hasYookassaChanges || updateSettingMutation.isPending}
                data-testid="button-save-yookassa"
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
