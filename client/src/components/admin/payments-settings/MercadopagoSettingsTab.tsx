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
import { ConnectionStatus, MERCADOPAGO_CURRENCIES } from "@/components/admin/payments-settings/shared";

export interface MercadopagoSettingsTabProps {
  t: TFunction<"translation", undefined>;
  isMercadopagoConfigured: any;
  mercadopagoConnectionStatus: ConnectionStatus;
  settings: any;
  mercadopagoFormData: { mercadopago_public_key: string; mercadopago_access_token: string; mercadopago_webhook_secret: string; mercadopago_currency: string; };
  handleMercadopagoChange: (key: "mercadopago_public_key" | "mercadopago_access_token" | "mercadopago_webhook_secret" | "mercadopago_currency", value: string) => void;
  showMercadopagoAccessToken: boolean;
  setShowMercadopagoAccessToken: Dispatch<SetStateAction<boolean>>;
  showMercadopagoWebhookSecret: boolean;
  setShowMercadopagoWebhookSecret: Dispatch<SetStateAction<boolean>>;
  toast: ReturnType<typeof useToast>["toast"];
  setupMercadopagoWebhookMutation: UseMutationResult<any, any, void, unknown>;
  testMercadopagoConnectionMutation: UseMutationResult<any, any, void, unknown>;
  saveMercadopagoSettings: () => Promise<void>;
  hasMercadopagoChanges: boolean;
  updateSettingMutation: UseMutationResult<{ key: string; data: any; }, any, { key: string; value: any; }, unknown>;
}

export function MercadopagoSettingsTab({ t, isMercadopagoConfigured, mercadopagoConnectionStatus, settings, mercadopagoFormData, handleMercadopagoChange, showMercadopagoAccessToken, setShowMercadopagoAccessToken, showMercadopagoWebhookSecret, setShowMercadopagoWebhookSecret, toast, setupMercadopagoWebhookMutation, testMercadopagoConnectionMutation, saveMercadopagoSettings, hasMercadopagoChanges, updateSettingMutation }: MercadopagoSettingsTabProps) {
  return (
    <TabsContent value="mercadopago">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CreditCard className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <CardTitle>{t("adminDashboard.payments.mercadopago.title")}</CardTitle>
                    <CardDescription>{t("adminDashboard.payments.mercadopago.description")}</CardDescription>
                  </div>
                </div>
                {isMercadopagoConfigured && (
                  <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    {t("adminDashboard.payments.gatewayAvailability.configured")}
                  </Badge>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-6">
              {mercadopagoConnectionStatus && (
                <Alert variant={mercadopagoConnectionStatus.connected ? "default" : "destructive"}>
                  {mercadopagoConnectionStatus.connected ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  <AlertDescription>
                    {mercadopagoConnectionStatus.connected
                      ? t("adminDashboard.payments.mercadopago.connectionSuccess")
                      : mercadopagoConnectionStatus.error || t("adminDashboard.payments.mercadopago.connectionFailed")
                    }
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="mercadopago_public_key">{t("adminDashboard.payments.mercadopago.publicKey")}</Label>
                    {settings?.mercadopago_public_key && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <Input
                    id="mercadopago_public_key"
                    type="text"
                    value={mercadopagoFormData.mercadopago_public_key}
                    onChange={(e) => handleMercadopagoChange("mercadopago_public_key", e.target.value)}
                    placeholder="TEST-... or APP_USR-..."
                    data-testid="input-mercadopago-public-key"
                  />
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.mercadopago.publicKeyHint")}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="mercadopago_access_token">{t("adminDashboard.payments.mercadopago.accessToken")}</Label>
                    {settings?.mercadopago_access_token && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                    <Input
                      id="mercadopago_access_token"
                      type={showMercadopagoAccessToken ? "text" : "password"}
                      value={mercadopagoFormData.mercadopago_access_token}
                      onChange={(e) => handleMercadopagoChange("mercadopago_access_token", e.target.value)}
                      placeholder={settings?.mercadopago_access_token ? "Enter new token to replace existing..." : "Enter your access token"}
                      className="border-0 shadow-none focus-visible:ring-0 flex-1"
                      data-testid="input-mercadopago-access-token"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setShowMercadopagoAccessToken(!showMercadopagoAccessToken)}
                      data-testid="button-toggle-mercadopago-token"
                    >
                      {showMercadopagoAccessToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.mercadopago.accessTokenHint")}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="mercadopago_webhook_secret">{t("adminDashboard.payments.mercadopago.webhookSecret")}</Label>
                    {settings?.mercadopago_webhook_secret && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                    <Input
                      id="mercadopago_webhook_secret"
                      type={showMercadopagoWebhookSecret ? "text" : "password"}
                      value={mercadopagoFormData.mercadopago_webhook_secret}
                      onChange={(e) => handleMercadopagoChange("mercadopago_webhook_secret", e.target.value)}
                      placeholder={settings?.mercadopago_webhook_secret ? "Enter new secret to replace existing..." : "Enter webhook secret"}
                      className="border-0 shadow-none focus-visible:ring-0 flex-1"
                      data-testid="input-mercadopago-webhook-secret"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setShowMercadopagoWebhookSecret(!showMercadopagoWebhookSecret)}
                      data-testid="button-toggle-mercadopago-webhook-secret"
                    >
                      {showMercadopagoWebhookSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.mercadopago.webhookSecretHint")}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mercadopago_currency">{t("adminDashboard.payments.mercadopago.currency")}</Label>
                  <Select
                    value={mercadopagoFormData.mercadopago_currency}
                    onValueChange={(value) => handleMercadopagoChange("mercadopago_currency", value)}
                  >
                    <SelectTrigger data-testid="select-mercadopago-currency">
                      <SelectValue placeholder={t("adminDashboard.payments.stripe.selectCurrency")} />
                    </SelectTrigger>
                    <SelectContent>
                      {MERCADOPAGO_CURRENCIES.map((currency) => (
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
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.mercadopago.currencyHint")}</p>
                </div>

                <div className="space-y-2 p-4 bg-muted/50 rounded-lg border">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Webhook className="h-4 w-4 text-muted-foreground" />
                      <Label className="font-medium">{t("adminDashboard.payments.mercadopago.webhookConfig")}</Label>
                    </div>
                    {settings?.mercadopago_webhook_id && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>

                  {settings?.mercadopago_webhook_id ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-2 bg-background rounded border text-sm font-mono break-all">
                          {window.location.origin}/api/mercadopago/webhook
                        </code>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => {
                            navigator.clipboard.writeText(`${window.location.origin}/api/mercadopago/webhook`);
                            toast({
                              title: t("adminDashboard.payments.redirectUrls.copied"),
                              description: t("adminDashboard.payments.mercadopago.webhookCopied"),
                            });
                          }}
                          data-testid="button-copy-mercadopago-webhook"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t("adminDashboard.payments.mercadopago.webhookId", { id: settings.mercadopago_webhook_id })}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setupMercadopagoWebhookMutation.mutate()}
                        disabled={setupMercadopagoWebhookMutation.isPending || !isMercadopagoConfigured}
                        data-testid="button-reconfigure-mercadopago-webhook"
                      >
                        {setupMercadopagoWebhookMutation.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Webhook className="h-4 w-4 mr-2" />
                        )}
                        {t("adminDashboard.payments.mercadopago.reconfigure")}
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        {t("adminDashboard.payments.mercadopago.webhookSetupInstructions")}
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-2 bg-background rounded border text-sm font-mono break-all">
                          {window.location.origin}/api/mercadopago/webhook
                        </code>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => {
                            navigator.clipboard.writeText(`${window.location.origin}/api/mercadopago/webhook`);
                            toast({
                              title: t("adminDashboard.payments.redirectUrls.copied"),
                              description: t("adminDashboard.payments.mercadopago.webhookCopied"),
                            });
                          }}
                          data-testid="button-copy-mercadopago-webhook"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      <Button
                        type="button"
                        onClick={() => setupMercadopagoWebhookMutation.mutate()}
                        disabled={setupMercadopagoWebhookMutation.isPending || !isMercadopagoConfigured}
                        data-testid="button-setup-mercadopago-webhook"
                      >
                        {setupMercadopagoWebhookMutation.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Webhook className="h-4 w-4 mr-2" />
                        )}
                        {t("adminDashboard.payments.mercadopago.setupAutomatically")}
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        {t("adminDashboard.payments.mercadopago.setupNote")}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {t("adminDashboard.payments.mercadopago.alert")}
                </AlertDescription>
              </Alert>
            </CardContent>

            <CardFooter className="flex justify-between gap-2 flex-wrap">
              <Button
                variant="outline"
                onClick={() => testMercadopagoConnectionMutation.mutate()}
                disabled={testMercadopagoConnectionMutation.isPending}
                data-testid="button-test-mercadopago"
              >
                {testMercadopagoConnectionMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <TestTube className="h-4 w-4 mr-2" />
                )}
                {t("adminDashboard.payments.testConnection")}
              </Button>
              <Button
                onClick={saveMercadopagoSettings}
                disabled={!hasMercadopagoChanges || updateSettingMutation.isPending}
                data-testid="button-save-mercadopago"
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
