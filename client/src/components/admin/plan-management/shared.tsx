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
import { CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTranslation } from "react-i18next";



export interface PluginCapabilities {
  capabilities: Record<string, boolean>;
  pluginBundles: Record<string, string>;
  sipEngine: boolean;
  restApi: boolean;
  teamManagement: boolean;
}

export interface Plan {
  id: string;
  name: string;
  displayName: string;
  description: string;
  monthlyPrice: number;
  yearlyPrice: number;
  razorpayMonthlyPrice?: number | null;
  razorpayYearlyPrice?: number | null;
  paypalMonthlyPrice?: number | null;
  paypalYearlyPrice?: number | null;
  paystackMonthlyPrice?: number | null;
  paystackYearlyPrice?: number | null;
  mercadopagoMonthlyPrice?: number | null;
  mercadopagoYearlyPrice?: number | null;
  yookassaMonthlyPrice?: number | null;
  yookassaYearlyPrice?: number | null;
  maxAgents: number;
  maxCampaigns: number;
  maxContactsPerCampaign: number;
  maxWebhooks: number;
  maxKnowledgeBases: number;
  maxFlows: number;
  maxPhoneNumbers: number;
  maxWidgets: number;
  includedCredits: number;
  defaultLlmModel?: string;
  canChooseLlm: boolean;
  canPurchaseNumbers: boolean;
  useSystemPool: boolean;
  sipEnabled: boolean;
  maxConcurrentSipCalls?: number;
  restApiEnabled: boolean;
  isActive: boolean;
  stripeProductId?: string | null;
  stripeMonthlyPriceId?: string | null;
  stripeYearlyPriceId?: string | null;
  razorpayPlanId?: string | null;
  razorpayYearlyPlanId?: string | null;
  paypalProductId?: string | null;
  paypalMonthlyPlanId?: string | null;
  paypalYearlyPlanId?: string | null;
  paystackMonthlyPlanCode?: string | null;
  paystackYearlyPlanCode?: string | null;
  mercadopagoMonthlyPlanId?: string | null;
  mercadopagoYearlyPlanId?: string | null;
  yookassaMonthlyPlanId?: string | null;
  yookassaYearlyPlanId?: string | null;
}

export interface PaymentGatewayConfig {
  stripeEnabled: boolean;
  razorpayEnabled: boolean;
  paypalEnabled: boolean;
  paystackEnabled: boolean;
  mercadopagoEnabled: boolean;
  yookassaEnabled: boolean;
  stripeCurrency?: string;
  stripeCurrencySymbol?: string;
  paypalCurrency?: string;
  paypalCurrencySymbol?: string;
  paystackCurrency?: string;
  paystackCurrencySymbol?: string;
  paystackCurrencies?: string[];
  paystackDefaultCurrency?: string;
  mercadopagoCurrency?: string;
  mercadopagoCurrencySymbol?: string;
  yookassaCurrency?: string;
  yookassaCurrencySymbol?: string;
}

export function RazorpaySyncStatus({ plan }: { plan: Plan }) {
  const { t } = useTranslation();
  
  // Check if this is a free plan (both USD prices are 0)
  const isFreePlan = plan.monthlyPrice === 0 && plan.yearlyPrice === 0;
  
  // Check if INR prices are configured (required for Razorpay sync)
  const hasMonthlyPrice = (plan.razorpayMonthlyPrice ?? 0) > 0;
  const hasYearlyPrice = (plan.razorpayYearlyPrice ?? 0) > 0;
  const hasAnyInrPricing = hasMonthlyPrice || hasYearlyPrice;
  
  // Check if plan IDs are set
  const hasMonthlyPlan = !!plan.razorpayPlanId;
  const hasYearlyPlan = !!plan.razorpayYearlyPlanId;
  
  // Fully synced: monthly plan exists (required), yearly plan exists if yearly price is set
  const isFullySynced = hasMonthlyPlan && (!hasYearlyPrice || hasYearlyPlan);
  
  // Partially synced: has some plan IDs but missing others that should exist
  const isPartiallySynced = hasAnyInrPricing && (hasMonthlyPlan || hasYearlyPlan) && !isFullySynced;
  
  // Not configured: no INR prices set at all (but only show if not a free plan)
  const isNotConfigured = !hasAnyInrPricing && !isFreePlan;
  
  if (isFullySynced) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-800">
              <CheckCircle2 className="h-3 w-3" />
              {t("adminDashboard.plans.status.synced", { gateway: "Razorpay" })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <p className="font-medium">{t("adminDashboard.plans.tooltips.integration", { gateway: "Razorpay" })}</p>
            <p className="text-muted-foreground truncate">{t("adminDashboard.plans.razorpay.monthlyPlan")}: {plan.razorpayPlanId}</p>
            {plan.razorpayYearlyPlanId && (
              <p className="text-muted-foreground truncate">{t("adminDashboard.plans.razorpay.yearlyPlan")}: {plan.razorpayYearlyPlanId}</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isPartiallySynced) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/30 dark:text-yellow-400 dark:border-yellow-800">
              <RefreshCw className="h-3 w-3" />
              {t("adminDashboard.plans.status.partial", { gateway: "Razorpay" })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <p className="font-medium">{t("adminDashboard.plans.tooltips.missingPlanIds", { gateway: "Razorpay" })}</p>
            {hasMonthlyPrice && !hasMonthlyPlan && <p className="text-destructive">{t("adminDashboard.plans.razorpay.noMonthlyId")}</p>}
            {hasYearlyPrice && !hasYearlyPlan && <p className="text-destructive">{t("adminDashboard.plans.razorpay.noYearlyId")}</p>}
            <p className="text-muted-foreground mt-1">{t("adminDashboard.plans.tooltips.saveToSync", { gateway: "Razorpay" })}</p>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isFreePlan) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800">
              <CheckCircle2 className="h-3 w-3" />
              {t("adminDashboard.plans.plans.free")}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{t("adminDashboard.plans.tooltips.freePlanNote", { gateway: "Razorpay" })}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isNotConfigured) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help text-muted-foreground">
              <XCircle className="h-3 w-3" />
              {t("adminDashboard.plans.noInrPricing")}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{t("adminDashboard.plans.setInrPrices")}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  // Has INR pricing but no plan IDs yet - needs to be saved to sync
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Badge variant="outline" className="gap-1 cursor-help bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-800">
            <RefreshCw className="h-3 w-3" />
            {t("adminDashboard.plans.status.needsSync")}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">{t("adminDashboard.plans.tooltips.saveToSync", { gateway: "Razorpay" })}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function StripeSyncStatus({ plan }: { plan: Plan }) {
  const { t } = useTranslation();
  
  const hasProduct = !!plan.stripeProductId;
  const hasMonthlyPrice = !!plan.stripeMonthlyPriceId;
  const hasYearlyPrice = !!plan.stripeYearlyPriceId || plan.yearlyPrice === 0;
  
  const isFullySynced = hasProduct && hasMonthlyPrice && hasYearlyPrice;
  const isPartiallySynced = hasProduct || hasMonthlyPrice || (plan.stripeYearlyPriceId && plan.yearlyPrice > 0);
  
  if (isFullySynced) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-800">
              <CheckCircle2 className="h-3 w-3" />
              {t("adminDashboard.plans.status.synced", { gateway: "Stripe" })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <p className="font-medium">{t("adminDashboard.plans.tooltips.integration", { gateway: "Stripe" })}</p>
            <p className="text-muted-foreground truncate">Product: {plan.stripeProductId}</p>
            <p className="text-muted-foreground truncate">Monthly: {plan.stripeMonthlyPriceId}</p>
            {plan.stripeYearlyPriceId && (
              <p className="text-muted-foreground truncate">Yearly: {plan.stripeYearlyPriceId}</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isPartiallySynced) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/30 dark:text-yellow-400 dark:border-yellow-800">
              <RefreshCw className="h-3 w-3" />
              {t("adminDashboard.plans.status.partial", { gateway: "Stripe" })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <p className="font-medium">{t("adminDashboard.plans.tooltips.missingPlanIds", { gateway: "Stripe" })}</p>
            {!hasProduct && <p className="text-destructive">No Stripe Product ID</p>}
            {!hasMonthlyPrice && <p className="text-destructive">No Monthly Price ID</p>}
            {!hasYearlyPrice && plan.yearlyPrice > 0 && <p className="text-destructive">No Yearly Price ID</p>}
            <p className="text-muted-foreground mt-1">{t("adminDashboard.plans.tooltips.saveToSync", { gateway: "Stripe" })}</p>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Badge variant="outline" className="gap-1 cursor-help bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800">
            <XCircle className="h-3 w-3" />
            {t("adminDashboard.plans.status.notSynced", { gateway: "Stripe" })}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">{t("adminDashboard.plans.status.notConfigured", { gateway: "Stripe" })}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function PayPalSyncStatus({ plan, paypalCurrency }: { plan: Plan; paypalCurrency: string }) {
  const { t } = useTranslation();
  const isFreePlan = plan.monthlyPrice === 0 && plan.yearlyPrice === 0;
  
  const hasMonthlyPrice = (plan.paypalMonthlyPrice ?? 0) > 0;
  const hasYearlyPrice = (plan.paypalYearlyPrice ?? 0) > 0;
  const hasAnyPricing = hasMonthlyPrice || hasYearlyPrice;
  
  const hasProduct = !!plan.paypalProductId;
  const hasMonthlyPlan = !!plan.paypalMonthlyPlanId;
  const hasYearlyPlan = !!plan.paypalYearlyPlanId;
  
  const isFullySynced = hasProduct && hasMonthlyPlan && (!hasYearlyPrice || hasYearlyPlan);
  const isPartiallySynced = hasAnyPricing && (hasProduct || hasMonthlyPlan || hasYearlyPlan) && !isFullySynced;
  const isNotConfigured = !hasAnyPricing && !isFreePlan;
  
  if (isFullySynced) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-800">
              <CheckCircle2 className="h-3 w-3" />
              {t("adminDashboard.plans.status.synced", { gateway: "PayPal" })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <p className="font-medium">{t("adminDashboard.plans.tooltips.integration", { gateway: `PayPal (${paypalCurrency})` })}</p>
            <p className="text-muted-foreground truncate">Product: {plan.paypalProductId}</p>
            <p className="text-muted-foreground truncate">Monthly: {plan.paypalMonthlyPlanId}</p>
            {plan.paypalYearlyPlanId && (
              <p className="text-muted-foreground truncate">Yearly: {plan.paypalYearlyPlanId}</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isPartiallySynced) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/30 dark:text-yellow-400 dark:border-yellow-800">
              <RefreshCw className="h-3 w-3" />
              {t("adminDashboard.plans.status.partial", { gateway: "PayPal" })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <p className="font-medium">{t("adminDashboard.plans.tooltips.missingPlanIds", { gateway: "PayPal" })}</p>
            {!hasProduct && <p className="text-destructive">No Product ID</p>}
            {hasMonthlyPrice && !hasMonthlyPlan && <p className="text-destructive">No Monthly Plan ID</p>}
            {hasYearlyPrice && !hasYearlyPlan && <p className="text-destructive">No Yearly Plan ID</p>}
            <p className="text-muted-foreground mt-1">{t("adminDashboard.plans.tooltips.clickToSync", { gateway: "PayPal" })}</p>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isFreePlan) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800">
              <CheckCircle2 className="h-3 w-3" />
              {t("adminDashboard.plans.plans.free")}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{t("adminDashboard.plans.tooltips.freePlanNote", { gateway: "PayPal" })}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isNotConfigured) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help text-muted-foreground">
              <XCircle className="h-3 w-3" />
              {t("adminDashboard.plans.tooltips.noPricing", { currency: paypalCurrency })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{t("adminDashboard.plans.tooltips.setPricing", { currency: paypalCurrency, gateway: "PayPal" })}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Badge variant="outline" className="gap-1 cursor-help bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-800">
            <RefreshCw className="h-3 w-3" />
            {t("adminDashboard.plans.status.needsSync")}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">{t("adminDashboard.plans.tooltips.setPricing", { currency: paypalCurrency, gateway: "PayPal" })} {t("adminDashboard.plans.tooltips.clickToSync", { gateway: "PayPal" })}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function PaystackSyncStatus({ plan, paystackCurrency }: { plan: Plan; paystackCurrency: string }) {
  const { t } = useTranslation();
  const isFreePlan = plan.monthlyPrice === 0 && plan.yearlyPrice === 0;
  
  const hasMonthlyPrice = (plan.paystackMonthlyPrice ?? 0) > 0;
  const hasYearlyPrice = (plan.paystackYearlyPrice ?? 0) > 0;
  const hasAnyPricing = hasMonthlyPrice || hasYearlyPrice;
  
  const hasMonthlyPlan = !!plan.paystackMonthlyPlanCode;
  const hasYearlyPlan = !!plan.paystackYearlyPlanCode;
  
  const isFullySynced = hasMonthlyPlan && (!hasYearlyPrice || hasYearlyPlan);
  const isPartiallySynced = hasAnyPricing && (hasMonthlyPlan || hasYearlyPlan) && !isFullySynced;
  const isNotConfigured = !hasAnyPricing && !isFreePlan;
  
  if (isFullySynced) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-800">
              <CheckCircle2 className="h-3 w-3" />
              {t("adminDashboard.plans.status.synced", { gateway: "Paystack" })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <p className="font-medium">{t("adminDashboard.plans.tooltips.integration", { gateway: `Paystack (${paystackCurrency})` })}</p>
            <p className="text-muted-foreground truncate">Monthly: {plan.paystackMonthlyPlanCode}</p>
            {plan.paystackYearlyPlanCode && (
              <p className="text-muted-foreground truncate">Yearly: {plan.paystackYearlyPlanCode}</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isPartiallySynced) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/30 dark:text-yellow-400 dark:border-yellow-800">
              <RefreshCw className="h-3 w-3" />
              {t("adminDashboard.plans.status.partial", { gateway: "Paystack" })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <p className="font-medium">{t("adminDashboard.plans.tooltips.missingPlanIds", { gateway: "Paystack" })}</p>
            {hasMonthlyPrice && !hasMonthlyPlan && <p className="text-destructive">No Monthly Plan Code</p>}
            {hasYearlyPrice && !hasYearlyPlan && <p className="text-destructive">No Yearly Plan Code</p>}
            <p className="text-muted-foreground mt-1">{t("adminDashboard.plans.tooltips.clickToSync", { gateway: "Paystack" })}</p>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isFreePlan) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800">
              <CheckCircle2 className="h-3 w-3" />
              {t("adminDashboard.plans.plans.free")}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{t("adminDashboard.plans.tooltips.freePlanNote", { gateway: "Paystack" })}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isNotConfigured) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help text-muted-foreground">
              <XCircle className="h-3 w-3" />
              {t("adminDashboard.plans.tooltips.noPricing", { currency: paystackCurrency })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{t("adminDashboard.plans.tooltips.setPricing", { currency: paystackCurrency, gateway: "Paystack" })}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Badge variant="outline" className="gap-1 cursor-help bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-800">
            <RefreshCw className="h-3 w-3" />
            {t("adminDashboard.plans.status.needsSync")}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">{t("adminDashboard.plans.tooltips.setPricing", { currency: paystackCurrency, gateway: "Paystack" })} {t("adminDashboard.plans.tooltips.clickToSync", { gateway: "Paystack" })}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function MercadoPagoSyncStatus({ plan, mercadopagoCurrency }: { plan: Plan; mercadopagoCurrency: string }) {
  const { t } = useTranslation();
  const isFreePlan = plan.monthlyPrice === 0 && plan.yearlyPrice === 0;
  
  const hasMonthlyPrice = (plan.mercadopagoMonthlyPrice ?? 0) > 0;
  const hasYearlyPrice = (plan.mercadopagoYearlyPrice ?? 0) > 0;
  const hasAnyPricing = hasMonthlyPrice || hasYearlyPrice;
  
  const hasMonthlyPlan = !!plan.mercadopagoMonthlyPlanId;
  const hasYearlyPlan = !!plan.mercadopagoYearlyPlanId;
  
  const isFullySynced = hasMonthlyPlan && (!hasYearlyPrice || hasYearlyPlan);
  const isPartiallySynced = hasAnyPricing && (hasMonthlyPlan || hasYearlyPlan) && !isFullySynced;
  const isNotConfigured = !hasAnyPricing && !isFreePlan;
  
  if (isFullySynced) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-800">
              <CheckCircle2 className="h-3 w-3" />
              {t("adminDashboard.plans.status.synced", { gateway: "MercadoPago" })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <p className="font-medium">{t("adminDashboard.plans.tooltips.integration", { gateway: `MercadoPago (${mercadopagoCurrency})` })}</p>
            <p className="text-muted-foreground truncate">Monthly: {plan.mercadopagoMonthlyPlanId}</p>
            {plan.mercadopagoYearlyPlanId && (
              <p className="text-muted-foreground truncate">Yearly: {plan.mercadopagoYearlyPlanId}</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isPartiallySynced) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/30 dark:text-yellow-400 dark:border-yellow-800">
              <RefreshCw className="h-3 w-3" />
              {t("adminDashboard.plans.status.partial", { gateway: "MercadoPago" })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <p className="font-medium">{t("adminDashboard.plans.tooltips.missingPlanIds", { gateway: "MercadoPago" })}</p>
            {hasMonthlyPrice && !hasMonthlyPlan && <p className="text-destructive">No Monthly Plan ID</p>}
            {hasYearlyPrice && !hasYearlyPlan && <p className="text-destructive">No Yearly Plan ID</p>}
            <p className="text-muted-foreground mt-1">{t("adminDashboard.plans.tooltips.clickToSync", { gateway: "MercadoPago" })}</p>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isFreePlan) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800">
              <CheckCircle2 className="h-3 w-3" />
              {t("adminDashboard.plans.plans.free")}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{t("adminDashboard.plans.tooltips.freePlanNote", { gateway: "MercadoPago" })}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isNotConfigured) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help text-muted-foreground">
              <XCircle className="h-3 w-3" />
              {t("adminDashboard.plans.tooltips.noPricing", { currency: mercadopagoCurrency })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{t("adminDashboard.plans.tooltips.setPricing", { currency: mercadopagoCurrency, gateway: "MercadoPago" })}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Badge variant="outline" className="gap-1 cursor-help bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-800">
            <RefreshCw className="h-3 w-3" />
            {t("adminDashboard.plans.status.needsSync")}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">{t("adminDashboard.plans.tooltips.setPricing", { currency: mercadopagoCurrency, gateway: "MercadoPago" })} {t("adminDashboard.plans.tooltips.clickToSync", { gateway: "MercadoPago" })}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function YookassaSyncStatus({ plan, yookassaCurrency }: { plan: Plan; yookassaCurrency: string }) {
  const { t } = useTranslation();
  const isFreePlan = plan.monthlyPrice === 0 && plan.yearlyPrice === 0;
  
  const hasMonthlyPrice = (plan.yookassaMonthlyPrice ?? 0) > 0;
  const hasYearlyPrice = (plan.yookassaYearlyPrice ?? 0) > 0;
  const hasAnyPricing = hasMonthlyPrice || hasYearlyPrice;
  
  const hasMonthlyPlan = !!plan.yookassaMonthlyPlanId;
  const hasYearlyPlan = !!plan.yookassaYearlyPlanId;
  
  const isFullySynced = hasMonthlyPlan && (!hasYearlyPrice || hasYearlyPlan);
  const isPartiallySynced = hasAnyPricing && (hasMonthlyPlan || hasYearlyPlan) && !isFullySynced;
  const isNotConfigured = !hasAnyPricing && !isFreePlan;
  
  if (isFullySynced) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-800">
              <CheckCircle2 className="h-3 w-3" />
              {t("adminDashboard.plans.status.synced", { gateway: "YooKassa" })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <p className="font-medium">{t("adminDashboard.plans.tooltips.integration", { gateway: `YooKassa (${yookassaCurrency})` })}</p>
            <p className="text-muted-foreground truncate">Monthly: {plan.yookassaMonthlyPlanId}</p>
            {plan.yookassaYearlyPlanId && (
              <p className="text-muted-foreground truncate">Yearly: {plan.yookassaYearlyPlanId}</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isPartiallySynced) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/30 dark:text-yellow-400 dark:border-yellow-800">
              <RefreshCw className="h-3 w-3" />
              {t("adminDashboard.plans.status.partial", { gateway: "YooKassa" })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <p className="font-medium">{t("adminDashboard.plans.tooltips.missingPlanIds", { gateway: "YooKassa" })}</p>
            {hasMonthlyPrice && !hasMonthlyPlan && <p className="text-destructive">No Monthly Plan ID</p>}
            {hasYearlyPrice && !hasYearlyPlan && <p className="text-destructive">No Yearly Plan ID</p>}
            <p className="text-muted-foreground mt-1">{t("adminDashboard.plans.tooltips.clickToSync", { gateway: "YooKassa" })}</p>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isFreePlan) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800">
              <CheckCircle2 className="h-3 w-3" />
              {t("adminDashboard.plans.plans.free")}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{t("adminDashboard.plans.tooltips.freePlanNote", { gateway: "YooKassa" })}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  if (isNotConfigured) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="outline" className="gap-1 cursor-help text-muted-foreground">
              <XCircle className="h-3 w-3" />
              {t("adminDashboard.plans.tooltips.noPricing", { currency: yookassaCurrency })}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{t("adminDashboard.plans.tooltips.setPricing", { currency: yookassaCurrency, gateway: "YooKassa" })}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Badge variant="outline" className="gap-1 cursor-help bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-800">
            <RefreshCw className="h-3 w-3" />
            {t("adminDashboard.plans.status.needsSync")}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">{t("adminDashboard.plans.tooltips.setPricing", { currency: yookassaCurrency, gateway: "YooKassa" })} {t("adminDashboard.plans.tooltips.clickToSync", { gateway: "YooKassa" })}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export interface MigrationState {
  plan: Plan;
  userCount: number;
  targetPlanId: string;
}