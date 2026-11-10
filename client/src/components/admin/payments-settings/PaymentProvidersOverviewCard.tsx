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
import { CheckCircle, XCircle, AlertCircle, ToggleLeft, Lock } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { TFunction } from "i18next";
import type { UseMutationResult } from "@tanstack/react-query";

export interface PaymentProvidersOverviewCardProps {
  t: TFunction<"translation", undefined>;
  stripeCurrencyLocked: boolean;
  stripeFormData: { stripe_secret_key: string; stripe_publishable_key: string; stripe_webhook_secret: string; stripe_currency: string; stripe_mode: string; };
  isStripeConfigured: any;
  stripeEnabled: boolean;
  toggleStripeEnabled: (enabled: boolean) => Promise<void>;
  updateSettingMutation: UseMutationResult<{ key: string; data: any; }, any, { key: string; value: any; }, unknown>;
  isRazorpayConfigured: any;
  razorpayEnabled: boolean;
  toggleRazorpayEnabled: (enabled: boolean) => Promise<void>;
  paypalFormData: { paypal_client_id: string; paypal_client_secret: string; paypal_webhook_id: string; paypal_mode: string; paypal_currency: string; };
  isPaypalConfigured: any;
  paypalEnabled: boolean;
  togglePaypalEnabled: (enabled: boolean) => Promise<void>;
  paystackFormData: { paystack_public_key: string; paystack_secret_key: string; paystack_webhook_secret: string; paystack_currency: string; };
  isPaystackConfigured: any;
  paystackEnabled: boolean;
  togglePaystackEnabled: (enabled: boolean) => Promise<void>;
  mercadopagoFormData: { mercadopago_public_key: string; mercadopago_access_token: string; mercadopago_webhook_secret: string; mercadopago_currency: string; };
  isMercadopagoConfigured: any;
  mercadopagoEnabled: boolean;
  toggleMercadopagoEnabled: (enabled: boolean) => Promise<void>;
  yookassaFormData: { yookassa_shop_id: string; yookassa_secret_key: string; yookassa_webhook_secret: string; yookassa_currency: string; };
  isYookassaConfigured: any;
  yookassaEnabled: boolean;
  toggleYookassaEnabled: (enabled: boolean) => Promise<void>;
}

export function PaymentProvidersOverviewCard({ t, stripeCurrencyLocked, stripeFormData, isStripeConfigured, stripeEnabled, toggleStripeEnabled, updateSettingMutation, isRazorpayConfigured, razorpayEnabled, toggleRazorpayEnabled, paypalFormData, isPaypalConfigured, paypalEnabled, togglePaypalEnabled, paystackFormData, isPaystackConfigured, paystackEnabled, togglePaystackEnabled, mercadopagoFormData, isMercadopagoConfigured, mercadopagoEnabled, toggleMercadopagoEnabled, yookassaFormData, isYookassaConfigured, yookassaEnabled, toggleYookassaEnabled }: PaymentProvidersOverviewCardProps) {
  return (
    <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <ToggleLeft className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle>{t("adminDashboard.payments.gatewayAvailability.title")}</CardTitle>
              <CardDescription>{t("adminDashboard.payments.gatewayAvailability.description")}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Stripe Toggle */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 md:p-4 rounded-lg border gap-3">
            <div className="flex items-start sm:items-center gap-3">
              <svg className="h-6 w-6 shrink-0 mt-0.5 sm:mt-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z" />
              </svg>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                  <span className="font-medium">{t("adminDashboard.payments.gatewayAvailability.stripe")}</span>
                  <Badge variant="outline" className="text-xs">
                    {stripeCurrencyLocked && <Lock className="h-3 w-3 mr-1" />}
                    {stripeFormData.stripe_currency}
                  </Badge>
                  {isStripeConfigured ? (
                    <Badge className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      {t("adminDashboard.payments.gatewayAvailability.configured")}
                    </Badge>
                  ) : (
                    <Badge className="text-xs bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20">
                      <XCircle className="h-3 w-3 mr-1" />
                      {t("adminDashboard.payments.gatewayAvailability.notConfigured")}
                    </Badge>
                  )}
                </div>
                <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">{t("adminDashboard.payments.gatewayAvailability.stripeDesc", { currency: stripeFormData.stripe_currency })}</p>
              </div>
            </div>
            <div className="w-full sm:w-auto flex justify-end shrink-0">
              <Switch
                checked={stripeEnabled}
                onCheckedChange={toggleStripeEnabled}
                disabled={!isStripeConfigured || updateSettingMutation.isPending}
                data-testid="switch-stripe-enabled"
              />
            </div>
          </div>

          {/* Razorpay Toggle */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 md:p-4 rounded-lg border gap-3">
            <div className="flex items-start sm:items-center gap-3">
              <svg className="h-6 w-6 shrink-0 mt-0.5 sm:mt-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.436 0l-11.91 7.773-1.174 4.276 6.625-4.297L11.65 24h4.391l6.395-24zM14.26 10.098L3.389 17.166 1.564 24h9.508l3.188-13.902z" />
              </svg>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                  <span className="font-medium">{t("adminDashboard.payments.gatewayAvailability.razorpay")}</span>
                  <Badge variant="outline" className="text-xs">INR</Badge>
                  {isRazorpayConfigured ? (
                    <Badge className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      {t("adminDashboard.payments.gatewayAvailability.configured")}
                    </Badge>
                  ) : (
                    <Badge className="text-xs bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20">
                      <XCircle className="h-3 w-3 mr-1" />
                      {t("adminDashboard.payments.gatewayAvailability.notConfigured")}
                    </Badge>
                  )}
                </div>
                <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">{t("adminDashboard.payments.gatewayAvailability.razorpayDesc")}</p>
              </div>
            </div>
            <div className="w-full sm:w-auto flex justify-end shrink-0">
              <Switch
                checked={razorpayEnabled}
                onCheckedChange={toggleRazorpayEnabled}
                disabled={!isRazorpayConfigured || updateSettingMutation.isPending}
                data-testid="switch-razorpay-enabled"
              />
            </div>
          </div>

          {/* PayPal Toggle */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 md:p-4 rounded-lg border gap-3">
            <div className="flex items-start sm:items-center gap-3">
              <svg className="h-6 w-6 shrink-0 mt-0.5 sm:mt-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944.901C5.026.382 5.474 0 5.998 0h7.46c2.57 0 4.578.543 5.69 1.81 1.01 1.15 1.304 2.42 1.012 4.287-.023.143-.047.288-.077.437-.983 5.05-4.349 6.797-8.647 6.797h-2.19c-.524 0-.968.382-1.05.9l-1.12 7.106zm14.146-14.42a3.35 3.35 0 0 0-.607-.541c-.013.076-.026.175-.041.254-.59 3.025-2.566 6.082-8.558 6.082h-2.19c-1.049 0-1.968.757-2.099 1.798l-1.12 7.106a.64.64 0 0 0 .633.739h3.553c.525 0 .969-.382 1.05-.901l.776-4.909c.082-.519.526-.901 1.05-.901h.658c4.299 0 7.665-1.747 8.648-6.797.324-1.664.18-3.022-.753-3.93z" />
              </svg>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                  <span className="font-medium">{t("adminDashboard.payments.gatewayAvailability.paypal")}</span>
                  <Badge variant="outline" className="text-xs">{paypalFormData.paypal_currency}</Badge>
                  {isPaypalConfigured ? (
                    <Badge className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      {t("adminDashboard.payments.gatewayAvailability.configured")}
                    </Badge>
                  ) : (
                    <Badge className="text-xs bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20">
                      <XCircle className="h-3 w-3 mr-1" />
                      {t("adminDashboard.payments.gatewayAvailability.notConfigured")}
                    </Badge>
                  )}
                </div>
                <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">{t("adminDashboard.payments.gatewayAvailability.paypalDesc", { currency: paypalFormData.paypal_currency })}</p>
              </div>
            </div>
            <div className="w-full sm:w-auto flex justify-end shrink-0">
              <Switch
                checked={paypalEnabled}
                onCheckedChange={togglePaypalEnabled}
                disabled={!isPaypalConfigured || updateSettingMutation.isPending}
                data-testid="switch-paypal-enabled"
              />
            </div>
          </div>

          {/* Paystack Toggle */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 md:p-4 rounded-lg border gap-3">
            <div className="flex items-start sm:items-center gap-3">
              <svg className="h-6 w-6 shrink-0 mt-0.5 sm:mt-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.604 10.89h18.792a.396.396 0 0 0 .396-.396V7.286a.396.396 0 0 0-.396-.396H2.604a.396.396 0 0 0-.396.396v3.208c0 .218.178.396.396.396zm0 6.22h18.792a.396.396 0 0 0 .396-.396v-3.208a.396.396 0 0 0-.396-.396H2.604a.396.396 0 0 0-.396.396v3.208c0 .218.178.396.396.396zm0-12.22h18.792a.396.396 0 0 0 .396-.396V1.286a.396.396 0 0 0-.396-.396H2.604a.396.396 0 0 0-.396.396v3.208c0 .218.178.396.396.396zm0 18h11.188a.396.396 0 0 0 .396-.396v-3.208a.396.396 0 0 0-.396-.396H2.604a.396.396 0 0 0-.396.396v3.208c0 .218.178.396.396.396z" />
              </svg>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                  <span className="font-medium">{t("adminDashboard.payments.gatewayAvailability.paystack")}</span>
                  <Badge variant="outline" className="text-xs">{paystackFormData.paystack_currency}</Badge>
                  {isPaystackConfigured ? (
                    <Badge className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      {t("adminDashboard.payments.gatewayAvailability.configured")}
                    </Badge>
                  ) : (
                    <Badge className="text-xs bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20">
                      <XCircle className="h-3 w-3 mr-1" />
                      {t("adminDashboard.payments.gatewayAvailability.notConfigured")}
                    </Badge>
                  )}
                </div>
                <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">{t("adminDashboard.payments.gatewayAvailability.paystackDesc", { currency: paystackFormData.paystack_currency })}</p>
              </div>
            </div>
            <div className="w-full sm:w-auto flex justify-end shrink-0">
              <Switch
                checked={paystackEnabled}
                onCheckedChange={togglePaystackEnabled}
                disabled={!isPaystackConfigured || updateSettingMutation.isPending}
                data-testid="switch-paystack-enabled"
              />
            </div>
          </div>

          {/* MercadoPago Toggle */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 md:p-4 rounded-lg border gap-3">
            <div className="flex items-start sm:items-center gap-3">
              <svg className="h-6 w-6 shrink-0 mt-0.5 sm:mt-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 4.8c3.974 0 7.2 3.226 7.2 7.2s-3.226 7.2-7.2 7.2-7.2-3.226-7.2-7.2S8.026 4.8 12 4.8zm0 1.8a5.4 5.4 0 1 0 0 10.8 5.4 5.4 0 0 0 0-10.8zm0 2.4a3 3 0 1 1 0 6 3 3 0 0 1 0-6z" />
              </svg>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                  <span className="font-medium">{t("adminDashboard.payments.gatewayAvailability.mercadopago")}</span>
                  <Badge variant="outline" className="text-xs">{mercadopagoFormData.mercadopago_currency}</Badge>
                  {isMercadopagoConfigured ? (
                    <Badge className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      {t("adminDashboard.payments.gatewayAvailability.configured")}
                    </Badge>
                  ) : (
                    <Badge className="text-xs bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20">
                      <XCircle className="h-3 w-3 mr-1" />
                      {t("adminDashboard.payments.gatewayAvailability.notConfigured")}
                    </Badge>
                  )}
                </div>
                <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">{t("adminDashboard.payments.gatewayAvailability.mercadopagoDesc", { currency: mercadopagoFormData.mercadopago_currency })}</p>
              </div>
            </div>
            <div className="w-full sm:w-auto flex justify-end shrink-0">
              <Switch
                checked={mercadopagoEnabled}
                onCheckedChange={toggleMercadopagoEnabled}
                disabled={!isMercadopagoConfigured || updateSettingMutation.isPending}
                data-testid="switch-mercadopago-enabled"
              />
            </div>
          </div>

          {/* YooKassa Toggle */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 md:p-4 rounded-lg border gap-3">
            <div className="flex items-start sm:items-center gap-3">
              <svg className="h-6 w-6 shrink-0 mt-0.5 sm:mt-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 4.8c3.974 0 7.2 3.226 7.2 7.2s-3.226 7.2-7.2 7.2-7.2-3.226-7.2-7.2S8.026 4.8 12 4.8z" />
              </svg>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                  <span className="font-medium">{t("adminDashboard.payments.gatewayAvailability.yookassa")}</span>
                  <Badge variant="outline" className="text-xs">{yookassaFormData.yookassa_currency}</Badge>
                  {isYookassaConfigured ? (
                    <Badge className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      {t("adminDashboard.payments.gatewayAvailability.configured")}
                    </Badge>
                  ) : (
                    <Badge className="text-xs bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20">
                      <XCircle className="h-3 w-3 mr-1" />
                      {t("adminDashboard.payments.gatewayAvailability.notConfigured")}
                    </Badge>
                  )}
                </div>
                <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">{t("adminDashboard.payments.gatewayAvailability.yookassaDesc", { currency: yookassaFormData.yookassa_currency })}</p>
              </div>
            </div>
            <div className="w-full sm:w-auto flex justify-end shrink-0">
              <Switch
                checked={yookassaEnabled}
                onCheckedChange={toggleYookassaEnabled}
                disabled={!isYookassaConfigured || updateSettingMutation.isPending}
                data-testid="switch-yookassa-enabled"
              />
            </div>
          </div>

          {/* Status Summary */}
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {(() => {
                const enabledGateways = [
                  stripeEnabled && `Stripe (${stripeFormData.stripe_currency})`,
                  razorpayEnabled && "Razorpay (INR)",
                  paypalEnabled && `PayPal (${paypalFormData.paypal_currency})`,
                  paystackEnabled && `Paystack (${paystackFormData.paystack_currency})`,
                  mercadopagoEnabled && `MercadoPago (${mercadopagoFormData.mercadopago_currency})`,
                  yookassaEnabled && `YooKassa (${yookassaFormData.yookassa_currency})`
                ].filter(Boolean);

                if (enabledGateways.length === 0) {
                  return t("adminDashboard.payments.gatewayAvailability.noGatewayEnabled");
                } else if (enabledGateways.length === 1) {
                  return t("adminDashboard.payments.gatewayAvailability.gatewaysEnabled_one", { gateway: enabledGateways[0] });
                } else {
                  return t("adminDashboard.payments.gatewayAvailability.gatewaysEnabled_other", { count: enabledGateways.length, gateways: enabledGateways.join(", ") });
                }
              })()}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
  );
}
