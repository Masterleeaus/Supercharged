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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Trash2, RefreshCw } from "lucide-react";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { TFunction } from "i18next";
import type { UseMutationResult } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";
import { Plan, PaymentGatewayConfig, RazorpaySyncStatus, StripeSyncStatus, PayPalSyncStatus, PaystackSyncStatus, MercadoPagoSyncStatus, YookassaSyncStatus } from "@/components/admin/plan-management/shared";

export interface PlanCardProps {
  plan: Plan;
  paymentGateway: PaymentGatewayConfig;
  paypalCurrency: string;
  paystackCurrency: string;
  mercadopagoCurrency: string;
  yookassaCurrency: string;
  isEditing: boolean;
  stripeCurrency: string;
  formData: Partial<Plan>;
  updateField: (planId: string, field: keyof Plan, value: any) => void;
  t: TFunction<"translation", undefined>;
  sipPluginInstalled: boolean;
  restApiPluginInstalled: boolean;
  handleSave: (planId: string) => void;
  updatePlan: UseMutationResult<Response, any, { planId: string; updates: Partial<Plan>; }, unknown>;
  handleCancel: () => void;
  stripeCurrencySymbol: string;
  paypalCurrencySymbol: string;
  paystackCurrencySymbol: string;
  mercadopagoCurrencySymbol: string;
  yookassaCurrencySymbol: string;
  syncToStripe: UseMutationResult<any, any, string, unknown>;
  syncToRazorpay: UseMutationResult<any, any, string, unknown>;
  syncToPayPal: UseMutationResult<any, any, string, unknown>;
  syncToPaystack: UseMutationResult<any, any, string, unknown>;
  syncToMercadoPago: UseMutationResult<any, any, string, unknown>;
  syncToYookassa: UseMutationResult<any, any, string, unknown>;
  handleEdit: (plan: Plan) => void;
  setDeletingPlan: Dispatch<SetStateAction<Plan>>;
}

export function PlanCard({ plan, paymentGateway, paypalCurrency, paystackCurrency, mercadopagoCurrency, yookassaCurrency, isEditing, stripeCurrency, formData, updateField, t, sipPluginInstalled, restApiPluginInstalled, handleSave, updatePlan, handleCancel, stripeCurrencySymbol, paypalCurrencySymbol, paystackCurrencySymbol, mercadopagoCurrencySymbol, yookassaCurrencySymbol, syncToStripe, syncToRazorpay, syncToPayPal, syncToPaystack, syncToMercadoPago, syncToYookassa, handleEdit, setDeletingPlan }: PlanCardProps) {
  return (
    <Card key={plan.id}>
              <CardHeader>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <CardTitle className="text-xl">
                    {plan.displayName}
                  </CardTitle>
                  <div className="flex items-center gap-2 flex-wrap">
                    {paymentGateway?.stripeEnabled && <StripeSyncStatus plan={plan} />}
                    {paymentGateway?.razorpayEnabled && <RazorpaySyncStatus plan={plan} />}
                    {paymentGateway?.paypalEnabled && <PayPalSyncStatus plan={plan} paypalCurrency={paypalCurrency} />}
                    {paymentGateway?.paystackEnabled && <PaystackSyncStatus plan={plan} paystackCurrency={paystackCurrency} />}
                    {paymentGateway?.mercadopagoEnabled && <MercadoPagoSyncStatus plan={plan} mercadopagoCurrency={mercadopagoCurrency} />}
                    {paymentGateway?.yookassaEnabled && <YookassaSyncStatus plan={plan} yookassaCurrency={yookassaCurrency} />}
                  </div>
                </div>
                <CardDescription>{plan.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {isEditing ? (
                  <>
                    {paymentGateway?.stripeEnabled && (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>Monthly Price ({stripeCurrency} - Stripe)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={formData.monthlyPrice}
                            onChange={(e) => updateField(plan.id, "monthlyPrice", parseFloat(e.target.value))}
                            data-testid={`input-plan-monthly-${plan.id}`}
                          />
                        </div>
                        <div>
                          <Label>Yearly Price ({stripeCurrency} - Stripe)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={formData.yearlyPrice}
                            onChange={(e) => updateField(plan.id, "yearlyPrice", parseFloat(e.target.value))}
                            data-testid={`input-plan-yearly-${plan.id}`}
                          />
                        </div>
                      </div>
                    )}

                    {paymentGateway?.razorpayEnabled && (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>Monthly Price (INR - Razorpay)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={formData.razorpayMonthlyPrice ?? 0}
                            onChange={(e) => updateField(plan.id, "razorpayMonthlyPrice", parseFloat(e.target.value))}
                            data-testid={`input-plan-monthly-inr-${plan.id}`}
                          />
                        </div>
                        <div>
                          <Label>Yearly Price (INR - Razorpay)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={formData.razorpayYearlyPrice ?? 0}
                            onChange={(e) => updateField(plan.id, "razorpayYearlyPrice", parseFloat(e.target.value))}
                            data-testid={`input-plan-yearly-inr-${plan.id}`}
                          />
                        </div>
                      </div>
                    )}

                    {paymentGateway?.paypalEnabled && (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>Monthly Price ({paypalCurrency} - PayPal)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={formData.paypalMonthlyPrice ?? 0}
                            onChange={(e) => updateField(plan.id, "paypalMonthlyPrice", parseFloat(e.target.value))}
                            data-testid={`input-plan-monthly-paypal-${plan.id}`}
                          />
                        </div>
                        <div>
                          <Label>Yearly Price ({paypalCurrency} - PayPal)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={formData.paypalYearlyPrice ?? 0}
                            onChange={(e) => updateField(plan.id, "paypalYearlyPrice", parseFloat(e.target.value))}
                            data-testid={`input-plan-yearly-paypal-${plan.id}`}
                          />
                        </div>
                      </div>
                    )}

                    {paymentGateway?.paystackEnabled && (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>Monthly Price ({paystackCurrency} - Paystack)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={formData.paystackMonthlyPrice ?? 0}
                            onChange={(e) => updateField(plan.id, "paystackMonthlyPrice", parseFloat(e.target.value))}
                            data-testid={`input-plan-monthly-paystack-${plan.id}`}
                          />
                        </div>
                        <div>
                          <Label>Yearly Price ({paystackCurrency} - Paystack)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={formData.paystackYearlyPrice ?? 0}
                            onChange={(e) => updateField(plan.id, "paystackYearlyPrice", parseFloat(e.target.value))}
                            data-testid={`input-plan-yearly-paystack-${plan.id}`}
                          />
                        </div>
                      </div>
                    )}

                    {paymentGateway?.mercadopagoEnabled && (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>Monthly Price ({mercadopagoCurrency} - MercadoPago)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={formData.mercadopagoMonthlyPrice ?? 0}
                            onChange={(e) => updateField(plan.id, "mercadopagoMonthlyPrice", parseFloat(e.target.value))}
                            data-testid={`input-plan-monthly-mercadopago-${plan.id}`}
                          />
                        </div>
                        <div>
                          <Label>Yearly Price ({mercadopagoCurrency} - MercadoPago)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={formData.mercadopagoYearlyPrice ?? 0}
                            onChange={(e) => updateField(plan.id, "mercadopagoYearlyPrice", parseFloat(e.target.value))}
                            data-testid={`input-plan-yearly-mercadopago-${plan.id}`}
                          />
                        </div>
                      </div>
                    )}

                    {paymentGateway?.yookassaEnabled && (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>Monthly Price ({yookassaCurrency} - YooKassa)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={formData.yookassaMonthlyPrice ?? 0}
                            onChange={(e) => updateField(plan.id, "yookassaMonthlyPrice", parseFloat(e.target.value))}
                            data-testid={`input-plan-monthly-yookassa-${plan.id}`}
                          />
                        </div>
                        <div>
                          <Label>Yearly Price ({yookassaCurrency} - YooKassa)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={formData.yookassaYearlyPrice ?? 0}
                            onChange={(e) => updateField(plan.id, "yookassaYearlyPrice", parseFloat(e.target.value))}
                            data-testid={`input-plan-yearly-yookassa-${plan.id}`}
                          />
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="flex items-center">
                          <Label>{t("adminDashboard.plans.maxAgents")}</Label>
                          <InfoTooltip content="Use -1 for unlimited" />
                        </div>
                        <Input
                          type="number"
                          value={formData.maxAgents}
                          onChange={(e) => updateField(plan.id, "maxAgents", parseInt(e.target.value, 10))}
                          data-testid={`input-plan-agents-${plan.id}`}
                        />
                      </div>
                      <div>
                        <div className="flex items-center">
                          <Label>{t("adminDashboard.plans.maxCampaigns")}</Label>
                          <InfoTooltip content="Use -1 for unlimited" />
                        </div>
                        <Input
                          type="number"
                          value={formData.maxCampaigns}
                          onChange={(e) => updateField(plan.id, "maxCampaigns", parseInt(e.target.value, 10))}
                          data-testid={`input-plan-campaigns-${plan.id}`}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="flex items-center">
                          <Label>{t("adminDashboard.plans.maxContactsPerCampaign")}</Label>
                          <InfoTooltip content="Use -1 for unlimited" />
                        </div>
                        <Input
                          type="number"
                          value={formData.maxContactsPerCampaign}
                          onChange={(e) => updateField(plan.id, "maxContactsPerCampaign", parseInt(e.target.value, 10))}
                          data-testid={`input-plan-contacts-${plan.id}`}
                        />
                      </div>
                      <div>
                        <div className="flex items-center">
                          <Label>{t("adminDashboard.plans.includedCredits")}</Label>
                          <InfoTooltip content="Credits included with plan (0 for none)" />
                        </div>
                        <Input
                          type="number"
                          value={formData.includedCredits}
                          onChange={(e) => updateField(plan.id, "includedCredits", parseInt(e.target.value, 10))}
                          data-testid={`input-plan-credits-${plan.id}`}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-4 gap-4">
                      <div>
                        <div className="flex items-center">
                          <Label>{t("adminDashboard.plans.maxWebhooks", "Max Webhooks")}</Label>
                          <InfoTooltip content="Use -1 for unlimited" />
                        </div>
                        <Input
                          type="number"
                          value={formData.maxWebhooks ?? 3}
                          onChange={(e) => updateField(plan.id, "maxWebhooks", parseInt(e.target.value, 10))}
                          data-testid={`input-plan-webhooks-${plan.id}`}
                        />
                      </div>
                      <div>
                        <div className="flex items-center">
                          <Label>{t("adminDashboard.plans.maxKnowledgeBases", "Max KBs")}</Label>
                          <InfoTooltip content="Use -1 for unlimited" />
                        </div>
                        <Input
                          type="number"
                          value={formData.maxKnowledgeBases ?? 5}
                          onChange={(e) => updateField(plan.id, "maxKnowledgeBases", parseInt(e.target.value, 10))}
                          data-testid={`input-plan-kbs-${plan.id}`}
                        />
                      </div>
                      <div>
                        <div className="flex items-center">
                          <Label>{t("adminDashboard.plans.maxFlows", "Max Flows")}</Label>
                          <InfoTooltip content="Use -1 for unlimited" />
                        </div>
                        <Input
                          type="number"
                          value={formData.maxFlows ?? 3}
                          onChange={(e) => updateField(plan.id, "maxFlows", parseInt(e.target.value, 10))}
                          data-testid={`input-plan-flows-${plan.id}`}
                        />
                      </div>
                      <div>
                        <div className="flex items-center">
                          <Label>{t("adminDashboard.plans.maxPhoneNumbers", "Max Phone #s")}</Label>
                          <InfoTooltip content="Use -1 for unlimited" />
                        </div>
                        <Input
                          type="number"
                          value={formData.maxPhoneNumbers ?? 1}
                          onChange={(e) => updateField(plan.id, "maxPhoneNumbers", parseInt(e.target.value, 10))}
                          data-testid={`input-plan-phones-${plan.id}`}
                        />
                      </div>
                      <div>
                        <div className="flex items-center">
                          <Label>{t("adminDashboard.plans.maxWidgets", "Max Widgets")}</Label>
                          <InfoTooltip content="Use -1 for unlimited" />
                        </div>
                        <Input
                          type="number"
                          value={formData.maxWidgets ?? 1}
                          onChange={(e) => updateField(plan.id, "maxWidgets", parseInt(e.target.value, 10))}
                          data-testid={`input-plan-widgets-${plan.id}`}
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>{t("adminDashboard.plans.canChooseLlm")}</Label>
                        <Switch
                          checked={formData.canChooseLlm}
                          onCheckedChange={(checked) => updateField(plan.id, "canChooseLlm", checked)}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label>{t("adminDashboard.plans.canPurchaseNumbers")}</Label>
                        <Switch
                          checked={formData.canPurchaseNumbers}
                          onCheckedChange={(checked) => updateField(plan.id, "canPurchaseNumbers", checked)}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label>{t("adminDashboard.plans.useSystemPool")}</Label>
                        <Switch
                          checked={formData.useSystemPool}
                          onCheckedChange={(checked) => updateField(plan.id, "useSystemPool", checked)}
                        />
                      </div>
                      {sipPluginInstalled && (
                        <div className="flex items-center justify-between">
                          <Label>SIP Trunk Access</Label>
                          <Switch
                            checked={formData.sipEnabled}
                            onCheckedChange={(checked) => updateField(plan.id, "sipEnabled", checked)}
                          />
                        </div>
                      )}
                      {sipPluginInstalled && formData.sipEnabled && (
                        <div className="flex items-center justify-between">
                          <Label>Max Concurrent SIP Calls</Label>
                          <Input
                            type="number"
                            min={1}
                            value={formData.maxConcurrentSipCalls ?? plan.maxConcurrentSipCalls ?? 1}
                            onChange={(e) => updateField(plan.id, "maxConcurrentSipCalls", parseInt(e.target.value, 10) || 1)}
                            className="w-24 text-right"
                            data-testid={`input-plan-max-concurrent-sip-${plan.id}`}
                          />
                        </div>
                      )}
                      {restApiPluginInstalled && (
                        <div className="flex items-center justify-between">
                          <Label>REST API Access</Label>
                          <Switch
                            checked={formData.restApiEnabled}
                            onCheckedChange={(checked) => updateField(plan.id, "restApiEnabled", checked)}
                          />
                        </div>
                      )}
                    </div>

                    <div className="flex gap-2">
                      <Button 
                        onClick={() => handleSave(plan.id)} 
                        disabled={updatePlan.isPending}
                        data-testid={`button-save-plan-${plan.id}`}
                      >
                        {updatePlan.isPending ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            {t("common.saving")}
                          </>
                        ) : (
                          t("common.saveChanges")
                        )}
                      </Button>
                      <Button 
                        variant="outline" 
                        onClick={handleCancel}
                        disabled={updatePlan.isPending}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="space-y-2 text-sm">
                      {paymentGateway?.stripeEnabled && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Pricing ({stripeCurrency} - Stripe)</span>
                          <span>{stripeCurrencySymbol}{plan.monthlyPrice}{t("adminDashboard.plans.perMonth")} {t("adminDashboard.plans.or")} {stripeCurrencySymbol}{plan.yearlyPrice}{t("adminDashboard.plans.perYear")}</span>
                        </div>
                      )}
                      {paymentGateway?.razorpayEnabled && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Pricing (INR - Razorpay)</span>
                          <span>₹{plan.razorpayMonthlyPrice ?? 0}{t("adminDashboard.plans.perMonth")} {t("adminDashboard.plans.or")} ₹{plan.razorpayYearlyPrice ?? 0}{t("adminDashboard.plans.perYear")}</span>
                        </div>
                      )}
                      {paymentGateway?.paypalEnabled && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Pricing ({paypalCurrency} - PayPal)</span>
                          <span>{paypalCurrencySymbol}{plan.paypalMonthlyPrice ?? 0}{t("adminDashboard.plans.perMonth")} {t("adminDashboard.plans.or")} {paypalCurrencySymbol}{plan.paypalYearlyPrice ?? 0}{t("adminDashboard.plans.perYear")}</span>
                        </div>
                      )}
                      {paymentGateway?.paystackEnabled && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Pricing ({paystackCurrency} - Paystack)</span>
                          <span>{paystackCurrencySymbol}{plan.paystackMonthlyPrice ?? 0}{t("adminDashboard.plans.perMonth")} {t("adminDashboard.plans.or")} {paystackCurrencySymbol}{plan.paystackYearlyPrice ?? 0}{t("adminDashboard.plans.perYear")}</span>
                        </div>
                      )}
                      {paymentGateway?.mercadopagoEnabled && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Pricing ({mercadopagoCurrency} - MercadoPago)</span>
                          <span>{mercadopagoCurrencySymbol}{plan.mercadopagoMonthlyPrice ?? 0}{t("adminDashboard.plans.perMonth")} {t("adminDashboard.plans.or")} {mercadopagoCurrencySymbol}{plan.mercadopagoYearlyPrice ?? 0}{t("adminDashboard.plans.perYear")}</span>
                        </div>
                      )}
                      {paymentGateway?.yookassaEnabled && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Pricing ({yookassaCurrency} - YooKassa)</span>
                          <span>{yookassaCurrencySymbol}{plan.yookassaMonthlyPrice ?? 0}{t("adminDashboard.plans.perMonth")} {t("adminDashboard.plans.or")} {yookassaCurrencySymbol}{plan.yookassaYearlyPrice ?? 0}{t("adminDashboard.plans.perYear")}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("adminDashboard.plans.maxAgents")}:</span>
                        <span>{plan.maxAgents === 999 ? t("adminDashboard.plans.unlimited") : plan.maxAgents}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("adminDashboard.plans.maxCampaigns")}:</span>
                        <span>{plan.maxCampaigns === 999 ? t("adminDashboard.plans.unlimited") : plan.maxCampaigns}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("adminDashboard.plans.maxContacts")}:</span>
                        <span>{plan.maxContactsPerCampaign === 999999 ? t("adminDashboard.plans.unlimited") : plan.maxContactsPerCampaign}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("adminDashboard.plans.maxWebhooks", "Max Webhooks")}:</span>
                        <span>{plan.maxWebhooks === 999 ? t("adminDashboard.plans.unlimited") : (plan.maxWebhooks ?? 3)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("adminDashboard.plans.maxKnowledgeBases", "Max KBs")}:</span>
                        <span>{plan.maxKnowledgeBases === 999 ? t("adminDashboard.plans.unlimited") : (plan.maxKnowledgeBases ?? 5)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("adminDashboard.plans.maxFlows", "Max Flows")}:</span>
                        <span>{plan.maxFlows === 999 ? t("adminDashboard.plans.unlimited") : (plan.maxFlows ?? 3)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("adminDashboard.plans.maxPhoneNumbers", "Max Phone #s")}:</span>
                        <span>{plan.maxPhoneNumbers === 999 ? t("adminDashboard.plans.unlimited") : (plan.maxPhoneNumbers ?? 1)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("adminDashboard.plans.maxWidgets", "Max Widgets")}:</span>
                        <span>{plan.maxWidgets === 999 ? t("adminDashboard.plans.unlimited") : (plan.maxWidgets ?? 1)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("adminDashboard.plans.includedCredits")}:</span>
                        <span>{plan.includedCredits}</span>
                      </div>
                    </div>

                    {/* Gateway Sync Buttons */}
                    <div className="flex flex-wrap gap-2 pt-2 border-t">
                      {paymentGateway?.stripeEnabled && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => syncToStripe.mutate(plan.id)}
                          disabled={syncToStripe.isPending || parseFloat(plan.monthlyPrice?.toString() || '0') === 0}
                          data-testid={`button-sync-stripe-${plan.id}`}
                        >
                          {syncToStripe.isPending ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3 w-3 mr-1" />
                          )}
                          Stripe
                        </Button>
                      )}
                      {paymentGateway?.razorpayEnabled && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => syncToRazorpay.mutate(plan.id)}
                          disabled={syncToRazorpay.isPending || !plan.razorpayMonthlyPrice || parseFloat(plan.razorpayMonthlyPrice?.toString() || '0') === 0}
                          data-testid={`button-sync-razorpay-${plan.id}`}
                        >
                          {syncToRazorpay.isPending ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3 w-3 mr-1" />
                          )}
                          Razorpay
                        </Button>
                      )}
                      {paymentGateway?.paypalEnabled && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => syncToPayPal.mutate(plan.id)}
                          disabled={syncToPayPal.isPending || !plan.paypalMonthlyPrice || parseFloat(plan.paypalMonthlyPrice?.toString() || '0') === 0}
                          data-testid={`button-sync-paypal-${plan.id}`}
                        >
                          {syncToPayPal.isPending ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3 w-3 mr-1" />
                          )}
                          PayPal
                        </Button>
                      )}
                      {paymentGateway?.paystackEnabled && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => syncToPaystack.mutate(plan.id)}
                          disabled={syncToPaystack.isPending || !plan.paystackMonthlyPrice || parseFloat(plan.paystackMonthlyPrice?.toString() || '0') === 0}
                          data-testid={`button-sync-paystack-${plan.id}`}
                        >
                          {syncToPaystack.isPending ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3 w-3 mr-1" />
                          )}
                          Paystack
                        </Button>
                      )}
                      {paymentGateway?.mercadopagoEnabled && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => syncToMercadoPago.mutate(plan.id)}
                          disabled={syncToMercadoPago.isPending || !plan.mercadopagoMonthlyPrice || parseFloat(plan.mercadopagoMonthlyPrice?.toString() || '0') === 0}
                          data-testid={`button-sync-mercadopago-${plan.id}`}
                        >
                          {syncToMercadoPago.isPending ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3 w-3 mr-1" />
                          )}
                          MercadoPago
                        </Button>
                      )}
                      {paymentGateway?.yookassaEnabled && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => syncToYookassa.mutate(plan.id)}
                          disabled={syncToYookassa.isPending || !plan.yookassaMonthlyPrice || parseFloat(plan.yookassaMonthlyPrice?.toString() || '0') === 0}
                          data-testid={`button-sync-yookassa-${plan.id}`}
                        >
                          {syncToYookassa.isPending ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3 w-3 mr-1" />
                          )}
                          YooKassa
                        </Button>
                      )}
                    </div>

                    <div className="flex gap-2">
                      <Button 
                        onClick={() => handleEdit(plan)}
                        data-testid={`button-edit-plan-${plan.id}`}
                        variant="outline"
                        className="flex-1"
                      >
                        {t("adminDashboard.plans.editPlan")}
                      </Button>
                      <Button 
                        onClick={() => setDeletingPlan(plan)}
                        data-testid={`button-delete-plan-${plan.id}`}
                        variant="destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
  );
}
