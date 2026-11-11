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
import { ConnectionStatus } from "@/components/admin/payments-settings/shared";

export interface RazorpaySettingsTabProps {
  t: TFunction<"translation", undefined>;
  isRazorpayConfigured: any;
  razorpayConnectionStatus: ConnectionStatus;
  settings: any;
  razorpayFormData: { razorpay_key_id: string; razorpay_key_secret: string; razorpay_webhook_secret: string; razorpay_mode: string; };
  handleRazorpayChange: (key: "razorpay_key_id" | "razorpay_key_secret" | "razorpay_webhook_secret" | "razorpay_mode", value: string) => void;
  showRazorpayKeySecret: boolean;
  setShowRazorpayKeySecret: Dispatch<SetStateAction<boolean>>;
  showRazorpayWebhookSecret: boolean;
  setShowRazorpayWebhookSecret: Dispatch<SetStateAction<boolean>>;
  testRazorpayWebhookMutation: UseMutationResult<any, any, void, unknown>;
  toast: ReturnType<typeof useToast>["toast"];
  testRazorpayConnectionMutation: UseMutationResult<any, any, void, unknown>;
  saveRazorpaySettings: () => Promise<void>;
  hasRazorpayChanges: boolean;
  updateSettingMutation: UseMutationResult<{ key: string; data: any; }, any, { key: string; value: any; }, unknown>;
}

export function RazorpaySettingsTab({ t, isRazorpayConfigured, razorpayConnectionStatus, settings, razorpayFormData, handleRazorpayChange, showRazorpayKeySecret, setShowRazorpayKeySecret, showRazorpayWebhookSecret, setShowRazorpayWebhookSecret, testRazorpayWebhookMutation, toast, testRazorpayConnectionMutation, saveRazorpaySettings, hasRazorpayChanges, updateSettingMutation }: RazorpaySettingsTabProps) {
  return (
    <TabsContent value="razorpay">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CreditCard className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <CardTitle>{t("adminDashboard.payments.razorpay.title")}</CardTitle>
                    <CardDescription>{t("adminDashboard.payments.razorpay.description")}</CardDescription>
                  </div>
                </div>
                {isRazorpayConfigured && (
                  <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    {t("adminDashboard.payments.gatewayAvailability.configured")}
                  </Badge>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-6">
              {razorpayConnectionStatus && (
                <Alert variant={razorpayConnectionStatus.connected ? "default" : "destructive"}>
                  {razorpayConnectionStatus.connected ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  <AlertDescription>
                    {razorpayConnectionStatus.connected
                      ? t("adminDashboard.payments.razorpay.connectionSuccess")
                      : razorpayConnectionStatus.error || t("adminDashboard.payments.razorpay.connectionFailed")
                    }
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="razorpay_key_id">{t("adminDashboard.payments.razorpay.keyId")}</Label>
                    {settings?.razorpay_key_id && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <Input
                    id="razorpay_key_id"
                    type="text"
                    value={razorpayFormData.razorpay_key_id}
                    onChange={(e) => handleRazorpayChange("razorpay_key_id", e.target.value)}
                    placeholder="rzp_test_..."
                    data-testid="input-razorpay-key-id"
                  />
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.razorpay.keyIdHint")}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="razorpay_key_secret">{t("adminDashboard.payments.razorpay.keySecret")}</Label>
                    {settings?.razorpay_key_secret && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                    <Input
                      id="razorpay_key_secret"
                      type={showRazorpayKeySecret ? "text" : "password"}
                      value={razorpayFormData.razorpay_key_secret}
                      onChange={(e) => handleRazorpayChange("razorpay_key_secret", e.target.value)}
                      placeholder={settings?.razorpay_key_secret ? "Enter new secret to replace existing..." : "Enter your key secret"}
                      className="border-0 shadow-none focus-visible:ring-0 flex-1"
                      data-testid="input-razorpay-key-secret"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setShowRazorpayKeySecret(!showRazorpayKeySecret)}
                    >
                      {showRazorpayKeySecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.razorpay.keySecretHint")}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="razorpay_webhook_secret">{t("adminDashboard.payments.razorpay.webhookSecret")}</Label>
                    {settings?.razorpay_webhook_secret && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                    <Input
                      id="razorpay_webhook_secret"
                      type={showRazorpayWebhookSecret ? "text" : "password"}
                      value={razorpayFormData.razorpay_webhook_secret}
                      onChange={(e) => handleRazorpayChange("razorpay_webhook_secret", e.target.value)}
                      placeholder={settings?.razorpay_webhook_secret ? "Enter new secret to replace existing..." : "Enter webhook secret"}
                      className="border-0 shadow-none focus-visible:ring-0 flex-1"
                      data-testid="input-razorpay-webhook-secret"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setShowRazorpayWebhookSecret(!showRazorpayWebhookSecret)}
                    >
                      {showRazorpayWebhookSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.razorpay.webhookSecretHint")}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="razorpay_mode">{t("adminDashboard.payments.razorpay.mode")}</Label>
                  <Select
                    value={razorpayFormData.razorpay_mode}
                    onValueChange={(value) => handleRazorpayChange("razorpay_mode", value)}
                  >
                    <SelectTrigger data-testid="select-razorpay-mode">
                      <SelectValue placeholder={t("adminDashboard.payments.selectMode")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="test">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20">
                            Test
                          </Badge>
                          <span className="text-muted-foreground">{t("adminDashboard.payments.razorpay.sandboxMode")}</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="live">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                            Live
                          </Badge>
                          <span className="text-muted-foreground">{t("adminDashboard.payments.razorpay.productionMode")}</span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.razorpay.modeHint")}</p>
                </div>

                <div className="space-y-2 p-4 bg-muted/50 rounded-lg border">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Webhook className="h-4 w-4 text-muted-foreground" />
                      <Label className="font-medium">{t("adminDashboard.payments.razorpay.webhookUrl")}</Label>
                    </div>
                    {settings?.razorpay_webhook_secret && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => testRazorpayWebhookMutation.mutate()}
                        disabled={testRazorpayWebhookMutation.isPending}
                        data-testid="button-test-razorpay-webhook"
                      >
                        {testRazorpayWebhookMutation.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <TestTube className="h-4 w-4 mr-2" />
                        )}
                        {t("adminDashboard.payments.razorpay.testWebhookSecret")}
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 bg-background rounded border text-sm font-mono break-all">
                      {window.location.origin}/api/razorpay/webhook
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        navigator.clipboard.writeText(`${window.location.origin}/api/razorpay/webhook`);
                        toast({
                          title: t("adminDashboard.payments.redirectUrls.copied"),
                          description: t("adminDashboard.payments.razorpay.webhookCopied"),
                        });
                      }}
                      data-testid="button-copy-razorpay-webhook"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="space-y-2 mt-3">
                    <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.razorpay.webhookUrlHint")}</p>
                    <p className="text-xs text-muted-foreground font-medium">{t("adminDashboard.payments.razorpay.subscribeEvents")}</p>
                    <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                      <li>payment.authorized</li>
                      <li>payment.captured</li>
                      <li>payment.failed</li>
                      <li>subscription.activated</li>
                      <li>subscription.charged</li>
                      <li>subscription.cancelled</li>
                    </ul>
                  </div>
                </div>
              </div>

              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {t("adminDashboard.payments.razorpay.alert")}
                </AlertDescription>
              </Alert>
            </CardContent>

            <CardFooter className="flex justify-between gap-2 flex-wrap">
              <Button
                variant="outline"
                onClick={() => testRazorpayConnectionMutation.mutate()}
                disabled={testRazorpayConnectionMutation.isPending}
                data-testid="button-test-razorpay"
              >
                {testRazorpayConnectionMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <TestTube className="h-4 w-4 mr-2" />
                )}
                {t("adminDashboard.payments.testConnection")}
              </Button>
              <Button
                onClick={saveRazorpaySettings}
                disabled={!hasRazorpayChanges || updateSettingMutation.isPending}
                data-testid="button-save-razorpay"
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
