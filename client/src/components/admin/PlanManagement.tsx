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
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useState, useMemo } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PluginCapabilities, Plan, PaymentGatewayConfig, MigrationState } from "@/components/admin/plan-management/shared";
import { PlanCreateForm } from "@/components/admin/plan-management/PlanCreateForm";
import { PlanCard } from "@/components/admin/plan-management/PlanCard";
import { PlanDeleteDialog } from "@/components/admin/plan-management/PlanDeleteDialog";
import { PlanMigrationDialog } from "@/components/admin/plan-management/PlanMigrationDialog";



export default function PlanManagement() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [editingPlan, setEditingPlan] = useState<string | null>(null);
  const [planForms, setPlanForms] = useState<Record<string, Partial<Plan>>>({});
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [deletingPlan, setDeletingPlan] = useState<Plan | null>(null);
  const [migrationState, setMigrationState] = useState<MigrationState | null>(null);
  const [newPlanForm, setNewPlanForm] = useState<Partial<Plan>>({
    name: "",
    displayName: "",
    description: "",
    monthlyPrice: 0,
    yearlyPrice: 0,
    razorpayMonthlyPrice: 0,
    razorpayYearlyPrice: 0,
    paypalMonthlyPrice: 0,
    paypalYearlyPrice: 0,
    paystackMonthlyPrice: 0,
    paystackYearlyPrice: 0,
    mercadopagoMonthlyPrice: 0,
    mercadopagoYearlyPrice: 0,
    yookassaMonthlyPrice: 0,
    yookassaYearlyPrice: 0,
    maxAgents: 1,
    maxCampaigns: 1,
    maxContactsPerCampaign: 5,
    maxWebhooks: 3,
    maxKnowledgeBases: 5,
    maxFlows: 3,
    maxPhoneNumbers: 1,
    maxWidgets: 1,
    includedCredits: 100,
    canChooseLlm: false,
    canPurchaseNumbers: false,
    useSystemPool: false,
    sipEnabled: false,
    maxConcurrentSipCalls: 1,
    restApiEnabled: false,
    isActive: true
  });

  const { data: plans, isLoading, isError } = useQuery<Plan[]>({
    queryKey: ["/api/admin/plans"],
  });

  // Fetch admin settings to get the current Stripe currency
  const { data: adminSettings } = useQuery<Record<string, string>>({
    queryKey: ["/api/admin/settings"],
  });
  
  // Fetch payment gateway configuration
  const { data: paymentGateway } = useQuery<PaymentGatewayConfig>({
    queryKey: ["/api/settings/payment-gateway"],
  });

  // Fetch plugin capabilities to conditionally show plugin-related options
  const { data: pluginCapabilities } = useQuery<{ success: boolean; data: PluginCapabilities }>({
    queryKey: ["/api/plugins/capabilities"],
  });

  // Check if SIP Engine and REST API plugins are installed
  const sipPluginInstalled = useMemo(() => {
    return pluginCapabilities?.data?.capabilities?.['sip-engine'] ?? false;
  }, [pluginCapabilities]);

  const restApiPluginInstalled = useMemo(() => {
    return pluginCapabilities?.data?.capabilities?.['rest-api'] ?? false;
  }, [pluginCapabilities]);
  
  // Get the Stripe currency (defaults to USD if not set)
  const stripeCurrency = adminSettings?.stripe_currency || "USD";
  
  // Get currencies for other gateways
  const paypalCurrency = paymentGateway?.paypalCurrency?.toUpperCase() || "USD";
  const paystackCurrency = paymentGateway?.paystackDefaultCurrency?.toUpperCase() || "NGN";
  const mercadopagoCurrency = paymentGateway?.mercadopagoCurrency?.toUpperCase() || "BRL";
  const yookassaCurrency = paymentGateway?.yookassaCurrency?.toUpperCase() || "RUB";
  
  // Currency symbol mapping
  const getCurrencySymbol = (currency: string) => {
    const symbols: Record<string, string> = {
      USD: "$",
      EUR: "€",
      GBP: "£",
      INR: "₹",
      AUD: "A$",
      CAD: "C$",
      JPY: "¥",
      CNY: "¥",
      NGN: "₦",
      GHS: "₵",
      ZAR: "R",
      KES: "KSh",
      BRL: "R$",
      MXN: "MX$",
      ARS: "AR$",
      CLP: "CLP$",
      COP: "COP$",
      RUB: "₽",
    };
    return symbols[currency] || currency + " ";
  };
  
  const stripeCurrencySymbol = getCurrencySymbol(stripeCurrency);
  const paypalCurrencySymbol = getCurrencySymbol(paypalCurrency);
  const paystackCurrencySymbol = getCurrencySymbol(paystackCurrency);
  const mercadopagoCurrencySymbol = getCurrencySymbol(mercadopagoCurrency);
  const yookassaCurrencySymbol = getCurrencySymbol(yookassaCurrency);

  const createPlan = useMutation({
    mutationFn: async (planData: Partial<Plan>) => {
      return apiRequest("POST", "/api/admin/plans", planData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/plans"] });
      toast({ title: t("adminDashboard.plans.planCreated") });
      setShowCreateForm(false);
      setNewPlanForm({
        name: "",
        displayName: "",
        description: "",
        monthlyPrice: 0,
        yearlyPrice: 0,
        razorpayMonthlyPrice: 0,
        razorpayYearlyPrice: 0,
        paypalMonthlyPrice: 0,
        paypalYearlyPrice: 0,
        paystackMonthlyPrice: 0,
        paystackYearlyPrice: 0,
        mercadopagoMonthlyPrice: 0,
        mercadopagoYearlyPrice: 0,
        yookassaMonthlyPrice: 0,
        yookassaYearlyPrice: 0,
        maxAgents: 1,
        maxCampaigns: 1,
        maxContactsPerCampaign: 5,
        maxWebhooks: 3,
        maxKnowledgeBases: 5,
        maxFlows: 3,
        maxPhoneNumbers: 1,
        maxWidgets: 1,
        includedCredits: 100,
        canChooseLlm: false,
        canPurchaseNumbers: false,
        useSystemPool: false,
        sipEnabled: false,
        maxConcurrentSipCalls: 1,
        restApiEnabled: false,
        isActive: true
      });
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.plans.createFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const updatePlan = useMutation({
    mutationFn: async ({ planId, updates }: { planId: string; updates: Partial<Plan> }) => {
      return apiRequest("PATCH", `/api/admin/plans/${planId}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/plans"] });
      toast({ title: t("adminDashboard.plans.planUpdated") });
      setEditingPlan(null);
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.plans.updateFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const deletePlan = useMutation({
    mutationFn: async (planId: string) => {
      const response = await apiRequest("DELETE", `/api/admin/plans/${planId}`);
      if (!response.ok) {
        const errorData = await response.json();
        throw { response: { json: () => Promise.resolve(errorData) }, ...errorData };
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/plans"] });
      toast({ title: t("adminDashboard.plans.planDeleted") });
      setDeletingPlan(null);
      setMigrationState(null);
    },
    onError: async (error: any) => {
      // Check if this is a migration required error
      if (error.error === 'USERS_NEED_MIGRATION' && deletingPlan) {
        // Show migration dialog
        setMigrationState({
          plan: deletingPlan,
          userCount: error.userCount || 0,
          targetPlanId: ''
        });
        setDeletingPlan(null);
        return;
      }
      
      toast({
        title: error?.error || t("adminDashboard.plans.deleteFailed"),
        description: error?.message || 'Failed to delete plan',
        variant: "destructive"
      });
      setDeletingPlan(null);
    }
  });

  const migrateUsers = useMutation({
    mutationFn: async ({ planId, targetPlanId }: { planId: string; targetPlanId: string }) => {
      const response = await apiRequest("POST", `/api/admin/plans/${planId}/migrate`, { targetPlanId });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Migration failed');
      }
      return response.json();
    },
    onSuccess: (data) => {
      toast({ 
        title: t("adminDashboard.plans.usersMigrated"),
        description: t("adminDashboard.plans.usersMigratedDesc", { 
          count: data.migratedCount, 
          plan: data.targetPlanName 
        })
      });
      // Now delete the plan
      if (migrationState) {
        deletePlan.mutate(migrationState.plan.id);
      }
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.plans.migrationFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const syncToStripe = useMutation({
    mutationFn: async (planId: string) => {
      const response = await apiRequest("POST", `/api/admin/plans/${planId}/sync/stripe`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Stripe sync failed');
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/plans"] });
      toast({ 
        title: "Stripe Sync Complete",
        description: data.message
      });
    },
    onError: (error: any) => {
      toast({
        title: "Stripe Sync Failed",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const syncToRazorpay = useMutation({
    mutationFn: async (planId: string) => {
      const response = await apiRequest("POST", `/api/admin/plans/${planId}/sync/razorpay`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Razorpay sync failed');
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/plans"] });
      toast({ 
        title: "Razorpay Sync Complete",
        description: data.message
      });
    },
    onError: (error: any) => {
      toast({
        title: "Razorpay Sync Failed",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const syncToPayPal = useMutation({
    mutationFn: async (planId: string) => {
      const response = await apiRequest("POST", `/api/admin/plans/${planId}/sync/paypal`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'PayPal sync failed');
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/plans"] });
      toast({ 
        title: "PayPal Sync Complete",
        description: data.message
      });
    },
    onError: (error: any) => {
      toast({
        title: "PayPal Sync Failed",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const syncToPaystack = useMutation({
    mutationFn: async (planId: string) => {
      const response = await apiRequest("POST", `/api/admin/plans/${planId}/sync/paystack`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Paystack sync failed');
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/plans"] });
      toast({ 
        title: "Paystack Sync Complete",
        description: data.message
      });
    },
    onError: (error: any) => {
      toast({
        title: "Paystack Sync Failed",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const syncToMercadoPago = useMutation({
    mutationFn: async (planId: string) => {
      const response = await apiRequest("POST", `/api/admin/plans/${planId}/sync/mercadopago`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'MercadoPago sync failed');
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/plans"] });
      toast({ 
        title: "MercadoPago Sync Complete",
        description: data.message
      });
    },
    onError: (error: any) => {
      toast({
        title: "MercadoPago Sync Failed",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const syncToYookassa = useMutation({
    mutationFn: async (planId: string) => {
      const response = await apiRequest("POST", `/api/admin/plans/${planId}/sync/yookassa`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'YooKassa sync failed');
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/plans"] });
      toast({ 
        title: "YooKassa Sync Complete",
        description: data.message
      });
    },
    onError: (error: any) => {
      toast({
        title: "YooKassa Sync Failed",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const handleEdit = (plan: Plan) => {
    setEditingPlan(plan.id);
    setPlanForms({
      ...planForms,
      [plan.id]: { ...plan }
    });
  };

  const handleSave = (planId: string) => {
    const updates = planForms[planId];
    if (!updates) return;
    
    // Normalize price fields to handle NaN and empty values
    const normalizedUpdates: Partial<Plan> = { ...updates };
    
    // Handle USD price fields (must be numbers, default to 0)
    if (normalizedUpdates.monthlyPrice !== undefined) {
      const val = normalizedUpdates.monthlyPrice;
      if (typeof val === 'number' && isNaN(val)) {
        normalizedUpdates.monthlyPrice = 0;
      }
    }
    if (normalizedUpdates.yearlyPrice !== undefined) {
      const val = normalizedUpdates.yearlyPrice;
      if (typeof val === 'number' && isNaN(val)) {
        normalizedUpdates.yearlyPrice = 0;
      }
    }
    
    // Handle gateway price fields (can be null, treat NaN and 0 as null)
    // Razorpay
    if (normalizedUpdates.razorpayMonthlyPrice !== undefined) {
      const val = normalizedUpdates.razorpayMonthlyPrice;
      if (val === null || (typeof val === 'number' && (isNaN(val) || val === 0))) {
        normalizedUpdates.razorpayMonthlyPrice = null;
      }
    }
    if (normalizedUpdates.razorpayYearlyPrice !== undefined) {
      const val = normalizedUpdates.razorpayYearlyPrice;
      if (val === null || (typeof val === 'number' && (isNaN(val) || val === 0))) {
        normalizedUpdates.razorpayYearlyPrice = null;
      }
    }
    // PayPal
    if (normalizedUpdates.paypalMonthlyPrice !== undefined) {
      const val = normalizedUpdates.paypalMonthlyPrice;
      if (val === null || (typeof val === 'number' && (isNaN(val) || val === 0))) {
        normalizedUpdates.paypalMonthlyPrice = null;
      }
    }
    if (normalizedUpdates.paypalYearlyPrice !== undefined) {
      const val = normalizedUpdates.paypalYearlyPrice;
      if (val === null || (typeof val === 'number' && (isNaN(val) || val === 0))) {
        normalizedUpdates.paypalYearlyPrice = null;
      }
    }
    // Paystack
    if (normalizedUpdates.paystackMonthlyPrice !== undefined) {
      const val = normalizedUpdates.paystackMonthlyPrice;
      if (val === null || (typeof val === 'number' && (isNaN(val) || val === 0))) {
        normalizedUpdates.paystackMonthlyPrice = null;
      }
    }
    if (normalizedUpdates.paystackYearlyPrice !== undefined) {
      const val = normalizedUpdates.paystackYearlyPrice;
      if (val === null || (typeof val === 'number' && (isNaN(val) || val === 0))) {
        normalizedUpdates.paystackYearlyPrice = null;
      }
    }
    // MercadoPago
    if (normalizedUpdates.mercadopagoMonthlyPrice !== undefined) {
      const val = normalizedUpdates.mercadopagoMonthlyPrice;
      if (val === null || (typeof val === 'number' && (isNaN(val) || val === 0))) {
        normalizedUpdates.mercadopagoMonthlyPrice = null;
      }
    }
    if (normalizedUpdates.mercadopagoYearlyPrice !== undefined) {
      const val = normalizedUpdates.mercadopagoYearlyPrice;
      if (val === null || (typeof val === 'number' && (isNaN(val) || val === 0))) {
        normalizedUpdates.mercadopagoYearlyPrice = null;
      }
    }
    // YooKassa
    if (normalizedUpdates.yookassaMonthlyPrice !== undefined) {
      const val = normalizedUpdates.yookassaMonthlyPrice;
      if (val === null || (typeof val === 'number' && (isNaN(val) || val === 0))) {
        normalizedUpdates.yookassaMonthlyPrice = null;
      }
    }
    if (normalizedUpdates.yookassaYearlyPrice !== undefined) {
      const val = normalizedUpdates.yookassaYearlyPrice;
      if (val === null || (typeof val === 'number' && (isNaN(val) || val === 0))) {
        normalizedUpdates.yookassaYearlyPrice = null;
      }
    }
    
    updatePlan.mutate({ planId, updates: normalizedUpdates });
  };

  const handleCancel = () => {
    setEditingPlan(null);
  };

  const updateField = (planId: string, field: keyof Plan, value: any) => {
    setPlanForms({
      ...planForms,
      [planId]: {
        ...planForms[planId],
        [field]: value
      }
    });
  };

  const updateNewPlanField = (field: keyof Plan, value: any) => {
    setNewPlanForm({
      ...newPlanForm,
      [field]: value
    });
  };

  const handleCreatePlan = () => {
    createPlan.mutate(newPlanForm);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl md:text-2xl font-bold">{t("adminDashboard.plans.title")}</h2>
          <p className="text-muted-foreground text-sm md:text-base">
            {t("adminDashboard.plans.description")}
          </p>
        </div>
        <Button 
          onClick={() => setShowCreateForm(!showCreateForm)}
          data-testid="button-toggle-create-plan"
        >
          {showCreateForm ? t("common.cancel") : t("adminDashboard.plans.addNewPlan")}
        </Button>
      </div>

      {showCreateForm && (
        <PlanCreateForm
          t={t}
          newPlanForm={newPlanForm}
          updateNewPlanField={updateNewPlanField}
          paymentGateway={paymentGateway}
          stripeCurrency={stripeCurrency}
          paypalCurrency={paypalCurrency}
          paystackCurrency={paystackCurrency}
          mercadopagoCurrency={mercadopagoCurrency}
          yookassaCurrency={yookassaCurrency}
          sipPluginInstalled={sipPluginInstalled}
          restApiPluginInstalled={restApiPluginInstalled}
          handleCreatePlan={handleCreatePlan}
          createPlan={createPlan}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {plans?.map((plan) => {
          const isEditing = editingPlan === plan.id;
          const formData = planForms[plan.id] || plan;

          return (
            <PlanCard
              key={plan.id}
              plan={plan}
              paymentGateway={paymentGateway}
              paypalCurrency={paypalCurrency}
              paystackCurrency={paystackCurrency}
              mercadopagoCurrency={mercadopagoCurrency}
              yookassaCurrency={yookassaCurrency}
              isEditing={isEditing}
              stripeCurrency={stripeCurrency}
              formData={formData}
              updateField={updateField}
              t={t}
              sipPluginInstalled={sipPluginInstalled}
              restApiPluginInstalled={restApiPluginInstalled}
              handleSave={handleSave}
              updatePlan={updatePlan}
              handleCancel={handleCancel}
              stripeCurrencySymbol={stripeCurrencySymbol}
              paypalCurrencySymbol={paypalCurrencySymbol}
              paystackCurrencySymbol={paystackCurrencySymbol}
              mercadopagoCurrencySymbol={mercadopagoCurrencySymbol}
              yookassaCurrencySymbol={yookassaCurrencySymbol}
              syncToStripe={syncToStripe}
              syncToRazorpay={syncToRazorpay}
              syncToPayPal={syncToPayPal}
              syncToPaystack={syncToPaystack}
              syncToMercadoPago={syncToMercadoPago}
              syncToYookassa={syncToYookassa}
              handleEdit={handleEdit}
              setDeletingPlan={setDeletingPlan}
            />
          );
        })}
      </div>

      <PlanDeleteDialog
        deletingPlan={deletingPlan}
        setDeletingPlan={setDeletingPlan}
        t={t}
        deletePlan={deletePlan}
      />

      {/* Migration Dialog - shown when trying to delete a plan with active users */}
      <PlanMigrationDialog
        migrationState={migrationState}
        setMigrationState={setMigrationState}
        t={t}
        plans={plans}
        migrateUsers={migrateUsers}
        deletePlan={deletePlan}
      />
    </div>
  );
}
