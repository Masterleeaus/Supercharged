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
import { Loader2 } from "lucide-react";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { TFunction } from "i18next";
import type { UseMutationResult } from "@tanstack/react-query";
import { Plan, PaymentGatewayConfig } from "@/components/admin/plan-management/shared";

export interface PlanCreateFormProps {
  t: TFunction<"translation", undefined>;
  newPlanForm: Partial<Plan>;
  updateNewPlanField: (field: keyof Plan, value: any) => void;
  paymentGateway: PaymentGatewayConfig;
  stripeCurrency: string;
  paypalCurrency: string;
  paystackCurrency: string;
  mercadopagoCurrency: string;
  yookassaCurrency: string;
  sipPluginInstalled: boolean;
  restApiPluginInstalled: boolean;
  handleCreatePlan: () => void;
  createPlan: UseMutationResult<Response, any, Partial<Plan>, unknown>;
}

export function PlanCreateForm({ t, newPlanForm, updateNewPlanField, paymentGateway, stripeCurrency, paypalCurrency, paystackCurrency, mercadopagoCurrency, yookassaCurrency, sipPluginInstalled, restApiPluginInstalled, handleCreatePlan, createPlan }: PlanCreateFormProps) {
  return (
    <Card>
          <CardHeader>
            <CardTitle>{t("adminDashboard.plans.createNewPlan")}</CardTitle>
            <CardDescription>{t("adminDashboard.plans.createDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>{t("adminDashboard.plans.planName")}</Label>
                <Input
                  type="text"
                  placeholder={t("adminDashboard.plans.planNamePlaceholder")}
                  value={newPlanForm.name}
                  onChange={(e) => updateNewPlanField("name", e.target.value)}
                  data-testid="input-new-plan-name"
                />
              </div>
              <div>
                <Label>{t("adminDashboard.plans.displayName")}</Label>
                <Input
                  type="text"
                  placeholder={t("adminDashboard.plans.displayNamePlaceholder")}
                  value={newPlanForm.displayName}
                  onChange={(e) => updateNewPlanField("displayName", e.target.value)}
                  data-testid="input-new-plan-display-name"
                />
              </div>
            </div>

            <div>
              <Label>{t("adminDashboard.plans.descriptionLabel")}</Label>
              <Input
                type="text"
                placeholder={t("adminDashboard.plans.descriptionPlaceholder")}
                value={newPlanForm.description}
                onChange={(e) => updateNewPlanField("description", e.target.value)}
                data-testid="input-new-plan-description"
              />
            </div>

            {paymentGateway?.stripeEnabled && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Monthly Price ({stripeCurrency} - Stripe)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={newPlanForm.monthlyPrice}
                    onChange={(e) => updateNewPlanField("monthlyPrice", parseFloat(e.target.value))}
                    data-testid="input-new-plan-monthly"
                  />
                </div>
                <div>
                  <Label>Yearly Price ({stripeCurrency} - Stripe)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={newPlanForm.yearlyPrice}
                    onChange={(e) => updateNewPlanField("yearlyPrice", parseFloat(e.target.value))}
                    data-testid="input-new-plan-yearly"
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
                    value={newPlanForm.razorpayMonthlyPrice ?? 0}
                    onChange={(e) => updateNewPlanField("razorpayMonthlyPrice", parseFloat(e.target.value))}
                    data-testid="input-new-plan-monthly-inr"
                  />
                </div>
                <div>
                  <Label>Yearly Price (INR - Razorpay)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={newPlanForm.razorpayYearlyPrice ?? 0}
                    onChange={(e) => updateNewPlanField("razorpayYearlyPrice", parseFloat(e.target.value))}
                    data-testid="input-new-plan-yearly-inr"
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
                    value={newPlanForm.paypalMonthlyPrice ?? 0}
                    onChange={(e) => updateNewPlanField("paypalMonthlyPrice", parseFloat(e.target.value))}
                    data-testid="input-new-plan-monthly-paypal"
                  />
                </div>
                <div>
                  <Label>Yearly Price ({paypalCurrency} - PayPal)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={newPlanForm.paypalYearlyPrice ?? 0}
                    onChange={(e) => updateNewPlanField("paypalYearlyPrice", parseFloat(e.target.value))}
                    data-testid="input-new-plan-yearly-paypal"
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
                    value={newPlanForm.paystackMonthlyPrice ?? 0}
                    onChange={(e) => updateNewPlanField("paystackMonthlyPrice", parseFloat(e.target.value))}
                    data-testid="input-new-plan-monthly-paystack"
                  />
                </div>
                <div>
                  <Label>Yearly Price ({paystackCurrency} - Paystack)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={newPlanForm.paystackYearlyPrice ?? 0}
                    onChange={(e) => updateNewPlanField("paystackYearlyPrice", parseFloat(e.target.value))}
                    data-testid="input-new-plan-yearly-paystack"
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
                    value={newPlanForm.mercadopagoMonthlyPrice ?? 0}
                    onChange={(e) => updateNewPlanField("mercadopagoMonthlyPrice", parseFloat(e.target.value))}
                    data-testid="input-new-plan-monthly-mercadopago"
                  />
                </div>
                <div>
                  <Label>Yearly Price ({mercadopagoCurrency} - MercadoPago)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={newPlanForm.mercadopagoYearlyPrice ?? 0}
                    onChange={(e) => updateNewPlanField("mercadopagoYearlyPrice", parseFloat(e.target.value))}
                    data-testid="input-new-plan-yearly-mercadopago"
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
                    value={newPlanForm.yookassaMonthlyPrice ?? 0}
                    onChange={(e) => updateNewPlanField("yookassaMonthlyPrice", parseFloat(e.target.value))}
                    data-testid="input-new-plan-monthly-yookassa"
                  />
                </div>
                <div>
                  <Label>Yearly Price ({yookassaCurrency} - YooKassa)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={newPlanForm.yookassaYearlyPrice ?? 0}
                    onChange={(e) => updateNewPlanField("yookassaYearlyPrice", parseFloat(e.target.value))}
                    data-testid="input-new-plan-yearly-yookassa"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-4">
              <div>
                <div className="flex items-center">
                  <Label>{t("adminDashboard.plans.maxAgents")}</Label>
                  <InfoTooltip content="Use -1 for unlimited" />
                </div>
                <Input
                  type="number"
                  value={newPlanForm.maxAgents}
                  onChange={(e) => updateNewPlanField("maxAgents", parseInt(e.target.value, 10))}
                  data-testid="input-new-plan-agents"
                />
              </div>
              <div>
                <div className="flex items-center">
                  <Label>{t("adminDashboard.plans.maxCampaigns")}</Label>
                  <InfoTooltip content="Use -1 for unlimited" />
                </div>
                <Input
                  type="number"
                  value={newPlanForm.maxCampaigns}
                  onChange={(e) => updateNewPlanField("maxCampaigns", parseInt(e.target.value, 10))}
                  data-testid="input-new-plan-campaigns"
                />
              </div>
              <div>
                <div className="flex items-center">
                  <Label>{t("adminDashboard.plans.maxContacts")}</Label>
                  <InfoTooltip content="Use -1 for unlimited" />
                </div>
                <Input
                  type="number"
                  value={newPlanForm.maxContactsPerCampaign}
                  onChange={(e) => updateNewPlanField("maxContactsPerCampaign", parseInt(e.target.value, 10))}
                  data-testid="input-new-plan-contacts"
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
                  value={newPlanForm.maxWebhooks}
                  onChange={(e) => updateNewPlanField("maxWebhooks", parseInt(e.target.value, 10))}
                  data-testid="input-new-plan-webhooks"
                />
              </div>
              <div>
                <div className="flex items-center">
                  <Label>{t("adminDashboard.plans.maxKnowledgeBases", "Max KBs")}</Label>
                  <InfoTooltip content="Use -1 for unlimited" />
                </div>
                <Input
                  type="number"
                  value={newPlanForm.maxKnowledgeBases}
                  onChange={(e) => updateNewPlanField("maxKnowledgeBases", parseInt(e.target.value, 10))}
                  data-testid="input-new-plan-kbs"
                />
              </div>
              <div>
                <div className="flex items-center">
                  <Label>{t("adminDashboard.plans.maxFlows", "Max Flows")}</Label>
                  <InfoTooltip content="Use -1 for unlimited" />
                </div>
                <Input
                  type="number"
                  value={newPlanForm.maxFlows}
                  onChange={(e) => updateNewPlanField("maxFlows", parseInt(e.target.value, 10))}
                  data-testid="input-new-plan-flows"
                />
              </div>
              <div>
                <div className="flex items-center">
                  <Label>{t("adminDashboard.plans.maxPhoneNumbers", "Max Phone #s")}</Label>
                  <InfoTooltip content="Use -1 for unlimited" />
                </div>
                <Input
                  type="number"
                  value={newPlanForm.maxPhoneNumbers}
                  onChange={(e) => updateNewPlanField("maxPhoneNumbers", parseInt(e.target.value, 10))}
                  data-testid="input-new-plan-phones"
                />
              </div>
              <div>
                <div className="flex items-center">
                  <Label>{t("adminDashboard.plans.maxWidgets", "Max Widgets")}</Label>
                  <InfoTooltip content="Use -1 for unlimited" />
                </div>
                <Input
                  type="number"
                  value={newPlanForm.maxWidgets}
                  onChange={(e) => updateNewPlanField("maxWidgets", parseInt(e.target.value, 10))}
                  data-testid="input-new-plan-widgets"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center">
                <Label>{t("adminDashboard.plans.includedCredits")}</Label>
                <InfoTooltip content="Credits included with plan (0 for none)" />
              </div>
              <Input
                type="number"
                value={newPlanForm.includedCredits}
                onChange={(e) => updateNewPlanField("includedCredits", parseInt(e.target.value, 10))}
                data-testid="input-new-plan-credits"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t("adminDashboard.plans.canChooseLlm")}</Label>
                <Switch
                  checked={newPlanForm.canChooseLlm}
                  onCheckedChange={(checked) => updateNewPlanField("canChooseLlm", checked)}
                  data-testid="switch-new-plan-llm"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label>{t("adminDashboard.plans.canPurchaseNumbers")}</Label>
                <Switch
                  checked={newPlanForm.canPurchaseNumbers}
                  onCheckedChange={(checked) => updateNewPlanField("canPurchaseNumbers", checked)}
                  data-testid="switch-new-plan-numbers"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label>{t("adminDashboard.plans.useSystemPool")}</Label>
                <Switch
                  checked={newPlanForm.useSystemPool}
                  onCheckedChange={(checked) => updateNewPlanField("useSystemPool", checked)}
                  data-testid="switch-new-plan-pool"
                />
              </div>
              {sipPluginInstalled && (
                <div className="flex items-center justify-between">
                  <Label>SIP Trunk Access</Label>
                  <Switch
                    checked={newPlanForm.sipEnabled}
                    onCheckedChange={(checked) => updateNewPlanField("sipEnabled", checked)}
                    data-testid="switch-new-plan-sip"
                  />
                </div>
              )}
              {sipPluginInstalled && newPlanForm.sipEnabled && (
                <div className="flex items-center justify-between">
                  <Label>Max Concurrent SIP Calls</Label>
                  <Input
                    type="number"
                    min={1}
                    value={newPlanForm.maxConcurrentSipCalls ?? 1}
                    onChange={(e) => updateNewPlanField("maxConcurrentSipCalls", parseInt(e.target.value, 10) || 1)}
                    className="w-24 text-right"
                    data-testid="input-new-plan-max-concurrent-sip"
                  />
                </div>
              )}
              {restApiPluginInstalled && (
                <div className="flex items-center justify-between">
                  <Label>REST API Access</Label>
                  <Switch
                    checked={newPlanForm.restApiEnabled}
                    onCheckedChange={(checked) => updateNewPlanField("restApiEnabled", checked)}
                    data-testid="switch-new-plan-restapi"
                  />
                </div>
              )}
              <div className="flex items-center justify-between">
                <Label>{t("adminDashboard.plans.activeLabel")}</Label>
                <Switch
                  checked={newPlanForm.isActive}
                  onCheckedChange={(checked) => updateNewPlanField("isActive", checked)}
                  data-testid="switch-new-plan-active"
                />
              </div>
            </div>

            <Button 
              onClick={handleCreatePlan} 
              disabled={createPlan.isPending}
              data-testid="button-create-plan"
            >
              {createPlan.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("adminDashboard.plans.creating")}
                </>
              ) : (
                t("adminDashboard.plans.createPlan")
              )}
            </Button>
          </CardContent>
        </Card>
  );
}
