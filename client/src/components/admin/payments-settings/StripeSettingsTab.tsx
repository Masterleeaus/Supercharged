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
import { CreditCard, Save, Loader2, CheckCircle, AlertCircle, TestTube, Eye, EyeOff, Lock, LockOpen, AlertTriangle, Webhook, Copy } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import type { TFunction } from "i18next";
import type { UseMutationResult } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";
import { ConnectionStatus, CURRENCIES } from "@/components/admin/payments-settings/shared";

export interface StripeSettingsTabProps {
  t: TFunction<"translation", undefined>;
  isStripeConfigured: any;
  stripeConnectionStatus: ConnectionStatus;
  settings: any;
  showStripeSecretKey: boolean;
  stripeFormData: { stripe_secret_key: string; stripe_publishable_key: string; stripe_webhook_secret: string; stripe_currency: string; stripe_mode: string; };
  handleStripeChange: (key: "stripe_secret_key" | "stripe_publishable_key" | "stripe_webhook_secret" | "stripe_currency" | "stripe_mode", value: string) => void;
  setShowStripeSecretKey: Dispatch<SetStateAction<boolean>>;
  showStripeWebhookSecret: boolean;
  setShowStripeWebhookSecret: Dispatch<SetStateAction<boolean>>;
  stripeCurrencyLocked: boolean;
  showLockConfirmDialog: boolean;
  setShowLockConfirmDialog: Dispatch<SetStateAction<boolean>>;
  lockCurrencyMutation: UseMutationResult<void, any, void, unknown>;
  toast: ReturnType<typeof useToast>["toast"];
  testStripeConnectionMutation: UseMutationResult<any, any, void, unknown>;
  saveStripeSettings: () => Promise<void>;
  hasStripeChanges: boolean;
  updateSettingMutation: UseMutationResult<{ key: string; data: any; }, any, { key: string; value: any; }, unknown>;
}

export function StripeSettingsTab({ t, isStripeConfigured, stripeConnectionStatus, settings, showStripeSecretKey, stripeFormData, handleStripeChange, setShowStripeSecretKey, showStripeWebhookSecret, setShowStripeWebhookSecret, stripeCurrencyLocked, showLockConfirmDialog, setShowLockConfirmDialog, lockCurrencyMutation, toast, testStripeConnectionMutation, saveStripeSettings, hasStripeChanges, updateSettingMutation }: StripeSettingsTabProps) {
  return (
    <TabsContent value="stripe">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CreditCard className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <CardTitle>{t("adminDashboard.payments.stripe.title")}</CardTitle>
                    <CardDescription>{t("adminDashboard.payments.stripe.description")}</CardDescription>
                  </div>
                </div>
                {isStripeConfigured && (
                  <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    {t("adminDashboard.payments.gatewayAvailability.configured")}
                  </Badge>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-6">
              {stripeConnectionStatus && (
                <Alert variant={stripeConnectionStatus.connected ? "default" : "destructive"}>
                  {stripeConnectionStatus.connected ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  <AlertDescription>
                    {stripeConnectionStatus.connected ? (
                      <div className="space-y-1">
                        <p>{t("adminDashboard.payments.stripe.connectionSuccess")}</p>
                        <p className="text-sm text-muted-foreground">
                          {t("adminDashboard.payments.stripe.mode")}: <strong>{stripeConnectionStatus.mode?.toUpperCase()}</strong> |
                          {" "}{t("adminDashboard.payments.stripe.source")}: <strong>{stripeConnectionStatus.source}</strong>
                        </p>
                      </div>
                    ) : (
                      stripeConnectionStatus.error
                    )}
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="stripe_secret_key">{t("adminDashboard.payments.secretKey")}</Label>
                    {settings?.stripe_secret_key && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Configured
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                    <Input
                      id="stripe_secret_key"
                      type={showStripeSecretKey ? "text" : "password"}
                      value={stripeFormData.stripe_secret_key}
                      onChange={(e) => handleStripeChange("stripe_secret_key", e.target.value)}
                      placeholder={settings?.stripe_secret_key ? "Enter new key to replace existing..." : "sk_test_..."}
                      className="border-0 shadow-none focus-visible:ring-0 flex-1"
                      data-testid="input-stripe-secret-key"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setShowStripeSecretKey(!showStripeSecretKey)}
                    >
                      {showStripeSecretKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.secretKeyHint")}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="stripe_publishable_key">{t("adminDashboard.payments.publishableKey")}</Label>
                  <Input
                    id="stripe_publishable_key"
                    type="text"
                    value={stripeFormData.stripe_publishable_key}
                    onChange={(e) => handleStripeChange("stripe_publishable_key", e.target.value)}
                    placeholder="pk_test_..."
                    data-testid="input-stripe-publishable-key"
                  />
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.publishableKeyHint")}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="stripe_webhook_secret">{t("adminDashboard.payments.stripe.webhookSecret")}</Label>
                    {settings?.stripe_webhook_secret && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                    <Input
                      id="stripe_webhook_secret"
                      type={showStripeWebhookSecret ? "text" : "password"}
                      value={stripeFormData.stripe_webhook_secret}
                      onChange={(e) => handleStripeChange("stripe_webhook_secret", e.target.value)}
                      placeholder={settings?.stripe_webhook_secret ? "Enter new secret to replace existing..." : "whsec_..."}
                      className="border-0 shadow-none focus-visible:ring-0 flex-1"
                      data-testid="input-stripe-webhook-secret"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setShowStripeWebhookSecret(!showStripeWebhookSecret)}
                      data-testid="button-toggle-stripe-webhook-secret"
                    >
                      {showStripeWebhookSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.stripe.webhookSecretHint")}</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="stripe_currency">
                        {stripeCurrencyLocked ? (
                          <span className="flex items-center gap-1">
                            <Lock className="h-3 w-3" />
                            {t("adminDashboard.payments.stripe.currencyLocked")}
                          </span>
                        ) : (
                          t("adminDashboard.payments.stripe.currency")
                        )}
                      </Label>
                      {!stripeCurrencyLocked && isStripeConfigured && (
                        <AlertDialog open={showLockConfirmDialog} onOpenChange={setShowLockConfirmDialog}>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              data-testid="button-lock-currency"
                            >
                              <LockOpen className="h-3 w-3 mr-1" />
                              {t("adminDashboard.payments.stripe.lockCurrency")}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle className="flex items-center gap-2">
                                <AlertTriangle className="h-5 w-5 text-amber-500" />
                                {t("adminDashboard.payments.stripe.confirmLockTitle")}
                              </AlertDialogTitle>
                              <AlertDialogDescription asChild>
                                <div className="space-y-3 text-sm text-muted-foreground">
                                  <p>
                                    {t("adminDashboard.payments.stripe.confirmLockBody", { currency: stripeFormData.stripe_currency })}
                                  </p>
                                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3">
                                    <p className="font-medium text-amber-600 dark:text-amber-400">
                                      {t("adminDashboard.payments.stripe.confirmLockWarning")}
                                    </p>
                                    <p className="mt-1">
                                      {t("adminDashboard.payments.stripe.confirmLockWarningDesc")}
                                    </p>
                                  </div>
                                  <p>
                                    {t("adminDashboard.payments.stripe.confirmLockInstruction", { currency: stripeFormData.stripe_currency })}
                                  </p>
                                </div>
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>{t("adminDashboard.payments.stripe.confirmLockCancel")}</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => lockCurrencyMutation.mutate()}
                                disabled={lockCurrencyMutation.isPending}
                                className="bg-amber-600 hover:bg-amber-700"
                              >
                                {lockCurrencyMutation.isPending ? (
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                ) : (
                                  <Lock className="h-4 w-4 mr-2" />
                                )}
                                {t("adminDashboard.payments.stripe.lockCurrency")}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                    <Select
                      value={stripeFormData.stripe_currency}
                      onValueChange={(value) => handleStripeChange("stripe_currency", value)}
                      disabled={stripeCurrencyLocked}
                    >
                      <SelectTrigger data-testid="select-stripe-currency" disabled={stripeCurrencyLocked}>
                        <SelectValue placeholder={t("adminDashboard.payments.stripe.selectCurrency")} />
                      </SelectTrigger>
                      <SelectContent>
                        {CURRENCIES.map((currency) => (
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
                    {stripeCurrencyLocked ? (
                      <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                        <Lock className="h-3 w-3" />
                        {t("adminDashboard.payments.stripe.currencyLockedHint", { currency: stripeFormData.stripe_currency })}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {t("adminDashboard.payments.stripe.currencyHint")}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="stripe_mode">{t("adminDashboard.payments.stripeMode")}</Label>
                    <Select
                      value={stripeFormData.stripe_mode}
                      onValueChange={(value) => handleStripeChange("stripe_mode", value)}
                    >
                      <SelectTrigger data-testid="select-stripe-mode">
                        <SelectValue placeholder={t("adminDashboard.payments.selectMode")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="test">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20">
                              Test
                            </Badge>
                            <span className="text-muted-foreground">{t("adminDashboard.payments.testMode")}</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="live">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                              Live
                            </Badge>
                            <span className="text-muted-foreground">{t("adminDashboard.payments.liveMode")}</span>
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* Webhook URL Section */}
              <div className="space-y-2 p-4 bg-muted/50 rounded-lg border">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Webhook className="h-4 w-4 text-muted-foreground" />
                    <Label className="font-medium">Webhook URL</Label>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-background p-2 rounded-md border">
                  <code className="flex-1 text-sm font-mono text-muted-foreground truncate">
                    {window.location.origin}/api/stripe/webhook
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => {
                      navigator.clipboard.writeText(`${window.location.origin}/api/stripe/webhook`);
                      toast({
                        title: t("adminDashboard.payments.redirectUrls.copied"),
                        description: t("adminDashboard.payments.stripe.webhookCopied"),
                      });
                    }}
                    data-testid="button-copy-stripe-webhook"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <div className="space-y-2 mt-3">
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.stripe.webhookUrlHint")}</p>
                  <p className="text-xs text-muted-foreground font-medium">{t("adminDashboard.payments.stripe.subscribeEvents")}</p>
                  <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                    <li>checkout.session.completed</li>
                    <li>invoice.payment_succeeded</li>
                    <li>invoice.payment_failed</li>
                    <li>customer.subscription.deleted</li>
                    <li>customer.subscription.updated</li>
                    <li>charge.dispute.created</li>
                    <li>charge.refunded</li>
                  </ul>
                </div>
              </div>
            </CardContent>

            <CardFooter className="flex justify-between gap-2 flex-wrap">
              <Button
                variant="outline"
                onClick={() => testStripeConnectionMutation.mutate()}
                disabled={testStripeConnectionMutation.isPending}
                data-testid="button-test-stripe"
              >
                {testStripeConnectionMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <TestTube className="h-4 w-4 mr-2" />
                )}
                {t("adminDashboard.payments.testConnection")}
              </Button>
              <Button
                onClick={saveStripeSettings}
                disabled={!hasStripeChanges || updateSettingMutation.isPending}
                data-testid="button-save-stripe"
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
