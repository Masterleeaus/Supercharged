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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect, useRef } from "react";
import { Loader2, AlertCircle, DollarSign } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectionStatus, sanitizeErrorMessage } from "@/components/admin/payments-settings/shared";
import { PaymentProvidersOverviewCard } from "@/components/admin/payments-settings/PaymentProvidersOverviewCard";
import { PaymentRedirectUrlsCard } from "@/components/admin/payments-settings/PaymentRedirectUrlsCard";
import { StripeSettingsTab } from "@/components/admin/payments-settings/StripeSettingsTab";
import { RazorpaySettingsTab } from "@/components/admin/payments-settings/RazorpaySettingsTab";
import { PaypalSettingsTab } from "@/components/admin/payments-settings/PaypalSettingsTab";
import { PaystackSettingsTab } from "@/components/admin/payments-settings/PaystackSettingsTab";
import { MercadopagoSettingsTab } from "@/components/admin/payments-settings/MercadopagoSettingsTab";
import { YookassaSettingsTab } from "@/components/admin/payments-settings/YookassaSettingsTab";
import { CurrencyChangeDialog } from "@/components/admin/payments-settings/CurrencyChangeDialog";



export default function PaymentsSettings() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [stripeFormData, setStripeFormData] = useState({
    stripe_secret_key: "",
    stripe_publishable_key: "",
    stripe_webhook_secret: "",
    stripe_currency: "USD",
    stripe_mode: "test"
  });

  const [stripeCurrencyLocked, setStripeCurrencyLocked] = useState(false);
  const [showLockConfirmDialog, setShowLockConfirmDialog] = useState(false);
  const [showCurrencyChangeDialog, setShowCurrencyChangeDialog] = useState(false);
  const [pendingCurrencyChange, setPendingCurrencyChange] = useState<string | null>(null);

  const [razorpayFormData, setRazorpayFormData] = useState({
    razorpay_key_id: "",
    razorpay_key_secret: "",
    razorpay_webhook_secret: "",
    razorpay_mode: "test",
  });

  const [stripeEnabled, setStripeEnabled] = useState(true);
  const [razorpayEnabled, setRazorpayEnabled] = useState(false);
  const [hasStripeChanges, setHasStripeChanges] = useState(false);
  const [hasRazorpayChanges, setHasRazorpayChanges] = useState(false);

  // Track if we just toggled to prevent useEffect from overriding local state
  const justToggledRef = useRef(false);
  const [showStripeSecretKey, setShowStripeSecretKey] = useState(false);
  const [showStripeWebhookSecret, setShowStripeWebhookSecret] = useState(false);
  const [showRazorpayKeySecret, setShowRazorpayKeySecret] = useState(false);
  const [showRazorpayWebhookSecret, setShowRazorpayWebhookSecret] = useState(false);
  const [stripeConnectionStatus, setStripeConnectionStatus] = useState<ConnectionStatus | null>(null);
  const [razorpayConnectionStatus, setRazorpayConnectionStatus] = useState<ConnectionStatus | null>(null);

  // PayPal state
  const [paypalFormData, setPaypalFormData] = useState({
    paypal_client_id: "",
    paypal_client_secret: "",
    paypal_webhook_id: "",
    paypal_mode: "sandbox",
    paypal_currency: "USD",
  });
  const [paypalEnabled, setPaypalEnabled] = useState(false);
  const [hasPaypalChanges, setHasPaypalChanges] = useState(false);
  const [showPaypalClientSecret, setShowPaypalClientSecret] = useState(false);
  const [paypalConnectionStatus, setPaypalConnectionStatus] = useState<ConnectionStatus | null>(null);

  // Paystack state
  const [paystackFormData, setPaystackFormData] = useState({
    paystack_public_key: "",
    paystack_secret_key: "",
    paystack_webhook_secret: "",
    paystack_currency: "NGN",
  });
  const [paystackEnabled, setPaystackEnabled] = useState(false);
  const [hasPaystackChanges, setHasPaystackChanges] = useState(false);
  const [showPaystackSecretKey, setShowPaystackSecretKey] = useState(false);
  const [showPaystackWebhookSecret, setShowPaystackWebhookSecret] = useState(false);
  const [paystackConnectionStatus, setPaystackConnectionStatus] = useState<ConnectionStatus | null>(null);

  // MercadoPago state
  const [mercadopagoFormData, setMercadopagoFormData] = useState({
    mercadopago_public_key: "",
    mercadopago_access_token: "",
    mercadopago_webhook_secret: "",
    mercadopago_currency: "BRL",
  });
  const [mercadopagoEnabled, setMercadopagoEnabled] = useState(false);
  const [hasMercadopagoChanges, setHasMercadopagoChanges] = useState(false);
  const [showMercadopagoAccessToken, setShowMercadopagoAccessToken] = useState(false);
  const [showMercadopagoWebhookSecret, setShowMercadopagoWebhookSecret] = useState(false);
  const [mercadopagoConnectionStatus, setMercadopagoConnectionStatus] = useState<ConnectionStatus | null>(null);

  // YooKassa state
  const [yookassaFormData, setYookassaFormData] = useState({
    yookassa_shop_id: "",
    yookassa_secret_key: "",
    yookassa_webhook_secret: "",
    yookassa_currency: "RUB",
  });
  const [yookassaEnabled, setYookassaEnabled] = useState(false);
  const [hasYookassaChanges, setHasYookassaChanges] = useState(false);
  const [showYookassaSecretKey, setShowYookassaSecretKey] = useState(false);
  const [showYookassaWebhookSecret, setShowYookassaWebhookSecret] = useState(false);
  const [yookassaConnectionStatus, setYookassaConnectionStatus] = useState<ConnectionStatus | null>(null);

  const { data: settings, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/settings"],
  });

  useEffect(() => {
    if (settings) {
      setStripeFormData({
        stripe_secret_key: "",
        stripe_publishable_key: settings.stripe_publishable_key || "",
        stripe_webhook_secret: "",
        stripe_currency: settings.stripe_currency || "USD",
        stripe_mode: settings.stripe_mode || "test"
      });
      setRazorpayFormData({
        razorpay_key_id: settings.razorpay_key_id || "",
        razorpay_key_secret: "",
        razorpay_webhook_secret: "",
        razorpay_mode: settings.razorpay_mode || "test",
      });

      // Load stripe currency locked state
      const toBool = (val: any): boolean => val === true || val === 'true';
      setStripeCurrencyLocked(toBool(settings.stripe_currency_locked));

      // Skip gateway toggle state update if we just toggled (prevents race condition)
      if (justToggledRef.current) {
        justToggledRef.current = false;
        return;
      }

      // Load gateway enabled states with proper string/boolean normalization
      // Settings values are stored as strings in database ("true"/"false")
      // Stripe enabled if configured and not explicitly disabled (default: enabled when configured)
      const stripeEnabledValue = settings.stripe_enabled;
      setStripeEnabled(settings.stripe_configured && (stripeEnabledValue === undefined || stripeEnabledValue === null || toBool(stripeEnabledValue)));
      // Razorpay enabled if configured and explicitly enabled (default: disabled)
      setRazorpayEnabled(settings.razorpay_configured && toBool(settings.razorpay_enabled));

      // PayPal settings
      setPaypalFormData({
        paypal_client_id: settings.paypal_client_id || "",
        paypal_client_secret: "",
        paypal_webhook_id: settings.paypal_webhook_id || "",
        paypal_mode: settings.paypal_mode || "sandbox",
        paypal_currency: settings.paypal_currency || "USD",
      });
      setPaypalEnabled(settings.paypal_configured && toBool(settings.paypal_enabled));

      // Paystack settings
      setPaystackFormData({
        paystack_public_key: settings.paystack_public_key || "",
        paystack_secret_key: "",
        paystack_webhook_secret: "",
        paystack_currency: settings.paystack_currency || "NGN",
      });
      setPaystackEnabled(settings.paystack_configured && toBool(settings.paystack_enabled));

      // MercadoPago settings
      setMercadopagoFormData({
        mercadopago_public_key: settings.mercadopago_public_key || "",
        mercadopago_access_token: "",
        mercadopago_webhook_secret: "",
        mercadopago_currency: settings.mercadopago_currency || "BRL",
      });
      setMercadopagoEnabled(settings.mercadopago_configured && toBool(settings.mercadopago_enabled));

      // YooKassa settings
      setYookassaFormData({
        yookassa_shop_id: settings.yookassa_shop_id || "",
        yookassa_secret_key: "",
        yookassa_webhook_secret: "",
        yookassa_currency: settings.yookassa_currency || "RUB",
      });
      setYookassaEnabled(settings.yookassa_configured && toBool(settings.yookassa_enabled));
    }
  }, [settings]);

  const updateSettingMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: any }) => {
      const response = await apiRequest("PATCH", `/api/admin/settings/${key}`, { value });
      const data = await response.json();
      return { key, data };
    },
    onSuccess: ({ key, data }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/settings"] });
      // Show warning toast if currency was changed
      if (data?.warning) {
        toast({
          title: t("adminDashboard.payments.toasts.currencyChanged"),
          description: data.warning,
          variant: "default",
          duration: 8000,
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.payments.updateFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const saveStripeSettings = async () => {
    try {
      const updates = [];

      if (stripeFormData.stripe_secret_key && stripeFormData.stripe_secret_key.trim().length > 0) {
        updates.push(updateSettingMutation.mutateAsync({ key: "stripe_secret_key", value: stripeFormData.stripe_secret_key }));
      }
      if (stripeFormData.stripe_publishable_key) {
        updates.push(updateSettingMutation.mutateAsync({ key: "stripe_publishable_key", value: stripeFormData.stripe_publishable_key }));
      }
      if (stripeFormData.stripe_webhook_secret && stripeFormData.stripe_webhook_secret.trim().length > 0) {
        updates.push(updateSettingMutation.mutateAsync({ key: "stripe_webhook_secret", value: stripeFormData.stripe_webhook_secret }));
      }
      // Only update currency if not locked
      if (!stripeCurrencyLocked) {
        updates.push(updateSettingMutation.mutateAsync({ key: "stripe_currency", value: stripeFormData.stripe_currency }));
      }
      updates.push(updateSettingMutation.mutateAsync({ key: "stripe_mode", value: stripeFormData.stripe_mode }));

      await Promise.all(updates);
      toast({ title: t("adminDashboard.payments.updateSuccess") });
      setHasStripeChanges(false);
      setStripeFormData(prev => ({ ...prev, stripe_secret_key: "", stripe_webhook_secret: "" }));
    } catch (error: any) {
      toast({
        title: t("adminDashboard.payments.updateFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  };

  const saveRazorpaySettings = async () => {
    try {
      if (razorpayFormData.razorpay_key_id || razorpayFormData.razorpay_key_secret) {
        const validateResponse = await apiRequest("POST", "/api/admin/validate-credentials/razorpay", {
          key_id: razorpayFormData.razorpay_key_id || undefined,
          key_secret: razorpayFormData.razorpay_key_secret || undefined,
        });
        const validateResult = await validateResponse.json();
        if (!validateResult.valid) {
          toast({
            title: t("adminDashboard.payments.razorpay.invalidCredentials"),
            description: validateResult.error || t("adminDashboard.payments.razorpay.invalidCredentialsDesc"),
            variant: "destructive"
          });
          return;
        }
      }

      const updates = [];

      if (razorpayFormData.razorpay_key_id) {
        updates.push(updateSettingMutation.mutateAsync({ key: "razorpay_key_id", value: razorpayFormData.razorpay_key_id }));
      }
      if (razorpayFormData.razorpay_key_secret && razorpayFormData.razorpay_key_secret.trim().length > 0) {
        updates.push(updateSettingMutation.mutateAsync({ key: "razorpay_key_secret", value: razorpayFormData.razorpay_key_secret }));
      }
      if (razorpayFormData.razorpay_webhook_secret && razorpayFormData.razorpay_webhook_secret.trim().length > 0) {
        updates.push(updateSettingMutation.mutateAsync({ key: "razorpay_webhook_secret", value: razorpayFormData.razorpay_webhook_secret }));
      }
      updates.push(updateSettingMutation.mutateAsync({ key: "razorpay_mode", value: razorpayFormData.razorpay_mode }));

      await Promise.all(updates);
      toast({ title: t("adminDashboard.payments.updateSuccess") });
      setHasRazorpayChanges(false);
      setRazorpayFormData(prev => ({ ...prev, razorpay_key_secret: "", razorpay_webhook_secret: "" }));
    } catch (error: any) {
      toast({
        title: t("adminDashboard.payments.updateFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  };

  const savePaypalSettings = async () => {
    try {
      const updates = [];

      if (paypalFormData.paypal_client_id) {
        updates.push(updateSettingMutation.mutateAsync({ key: "paypal_client_id", value: paypalFormData.paypal_client_id }));
      }
      if (paypalFormData.paypal_client_secret && paypalFormData.paypal_client_secret.trim().length > 0) {
        updates.push(updateSettingMutation.mutateAsync({ key: "paypal_client_secret", value: paypalFormData.paypal_client_secret }));
      }
      if (paypalFormData.paypal_webhook_id) {
        updates.push(updateSettingMutation.mutateAsync({ key: "paypal_webhook_id", value: paypalFormData.paypal_webhook_id }));
      }
      updates.push(updateSettingMutation.mutateAsync({ key: "paypal_mode", value: paypalFormData.paypal_mode }));
      updates.push(updateSettingMutation.mutateAsync({ key: "paypal_currency", value: paypalFormData.paypal_currency }));

      await Promise.all(updates);
      toast({ title: t("adminDashboard.payments.updateSuccess") });
      setHasPaypalChanges(false);
      setPaypalFormData(prev => ({ ...prev, paypal_client_secret: "" }));
    } catch (error: any) {
      toast({
        title: t("adminDashboard.payments.updateFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  };

  const savePaystackSettings = async () => {
    try {
      const updates = [];

      if (paystackFormData.paystack_public_key) {
        updates.push(updateSettingMutation.mutateAsync({ key: "paystack_public_key", value: paystackFormData.paystack_public_key }));
      }
      if (paystackFormData.paystack_secret_key && paystackFormData.paystack_secret_key.trim().length > 0) {
        updates.push(updateSettingMutation.mutateAsync({ key: "paystack_secret_key", value: paystackFormData.paystack_secret_key }));
      }
      if (paystackFormData.paystack_webhook_secret && paystackFormData.paystack_webhook_secret.trim().length > 0) {
        updates.push(updateSettingMutation.mutateAsync({ key: "paystack_webhook_secret", value: paystackFormData.paystack_webhook_secret }));
      }
      updates.push(updateSettingMutation.mutateAsync({ key: "paystack_currency", value: paystackFormData.paystack_currency }));

      await Promise.all(updates);
      toast({ title: t("adminDashboard.payments.updateSuccess") });
      setHasPaystackChanges(false);
      setPaystackFormData(prev => ({ ...prev, paystack_secret_key: "", paystack_webhook_secret: "" }));
    } catch (error: any) {
      toast({
        title: t("adminDashboard.payments.updateFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  };

  const saveMercadopagoSettings = async () => {
    try {
      const updates = [];

      if (mercadopagoFormData.mercadopago_public_key) {
        updates.push(updateSettingMutation.mutateAsync({ key: "mercadopago_public_key", value: mercadopagoFormData.mercadopago_public_key }));
      }
      if (mercadopagoFormData.mercadopago_access_token && mercadopagoFormData.mercadopago_access_token.trim().length > 0) {
        updates.push(updateSettingMutation.mutateAsync({ key: "mercadopago_access_token", value: mercadopagoFormData.mercadopago_access_token }));
      }
      if (mercadopagoFormData.mercadopago_webhook_secret && mercadopagoFormData.mercadopago_webhook_secret.trim().length > 0) {
        updates.push(updateSettingMutation.mutateAsync({ key: "mercadopago_webhook_secret", value: mercadopagoFormData.mercadopago_webhook_secret }));
      }
      updates.push(updateSettingMutation.mutateAsync({ key: "mercadopago_currency", value: mercadopagoFormData.mercadopago_currency }));

      await Promise.all(updates);
      toast({ title: t("adminDashboard.payments.updateSuccess") });
      setHasMercadopagoChanges(false);
      setMercadopagoFormData(prev => ({ ...prev, mercadopago_access_token: "", mercadopago_webhook_secret: "" }));
    } catch (error: any) {
      toast({
        title: t("adminDashboard.payments.updateFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  };

  const saveYookassaSettings = async () => {
    try {
      const updates = [];

      if (yookassaFormData.yookassa_shop_id) {
        updates.push(updateSettingMutation.mutateAsync({ key: "yookassa_shop_id", value: yookassaFormData.yookassa_shop_id }));
      }
      if (yookassaFormData.yookassa_secret_key && yookassaFormData.yookassa_secret_key.trim().length > 0) {
        updates.push(updateSettingMutation.mutateAsync({ key: "yookassa_secret_key", value: yookassaFormData.yookassa_secret_key }));
      }
      if (yookassaFormData.yookassa_webhook_secret && yookassaFormData.yookassa_webhook_secret.trim().length > 0) {
        updates.push(updateSettingMutation.mutateAsync({ key: "yookassa_webhook_secret", value: yookassaFormData.yookassa_webhook_secret }));
      }
      updates.push(updateSettingMutation.mutateAsync({ key: "yookassa_currency", value: yookassaFormData.yookassa_currency }));

      await Promise.all(updates);
      toast({ title: t("adminDashboard.payments.updateSuccess") });
      setHasYookassaChanges(false);
      setYookassaFormData(prev => ({ ...prev, yookassa_secret_key: "", yookassa_webhook_secret: "" }));
    } catch (error: any) {
      toast({
        title: t("adminDashboard.payments.updateFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  };

  const toggleStripeEnabled = async (enabled: boolean) => {
    try {
      // Set flag to prevent useEffect from overriding our change
      justToggledRef.current = true;
      setStripeEnabled(enabled);
      await updateSettingMutation.mutateAsync({ key: "stripe_enabled", value: enabled });
      toast({
        title: enabled ? t("adminDashboard.payments.toasts.stripeEnabled") : t("adminDashboard.payments.toasts.stripeDisabled"),
        description: enabled
          ? t("adminDashboard.payments.toasts.stripeEnabledDesc")
          : t("adminDashboard.payments.toasts.stripeDisabledDesc")
      });
    } catch (error: any) {
      // Revert on error
      setStripeEnabled(!enabled);
      justToggledRef.current = false;
      toast({
        title: t("adminDashboard.payments.toasts.stripeToggleFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  };

  const toggleRazorpayEnabled = async (enabled: boolean) => {
    try {
      if (enabled) {
        const testResponse = await apiRequest("POST", "/api/admin/test-connection/razorpay");
        const testResult = await testResponse.json();
        if (!testResult.connected) {
          toast({
            title: t("adminDashboard.payments.toasts.razorpayEnableFailed"),
            description: testResult.error || t("adminDashboard.payments.toasts.razorpayEnableFailedDesc"),
            variant: "destructive"
          });
          return;
        }
      }
      justToggledRef.current = true;
      setRazorpayEnabled(enabled);
      await updateSettingMutation.mutateAsync({ key: "razorpay_enabled", value: enabled });
      toast({
        title: enabled ? t("adminDashboard.payments.toasts.razorpayEnabled") : t("adminDashboard.payments.toasts.razorpayDisabled"),
        description: enabled
          ? t("adminDashboard.payments.toasts.razorpayEnabledDesc")
          : t("adminDashboard.payments.toasts.razorpayDisabledDesc")
      });
    } catch (error: any) {
      setRazorpayEnabled(!enabled);
      justToggledRef.current = false;
      toast({
        title: t("adminDashboard.payments.toasts.razorpayToggleFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  };

  const togglePaypalEnabled = async (enabled: boolean) => {
    try {
      justToggledRef.current = true;
      setPaypalEnabled(enabled);
      await updateSettingMutation.mutateAsync({ key: "paypal_enabled", value: enabled });
      toast({
        title: enabled ? t("adminDashboard.payments.toasts.paypalEnabled") : t("adminDashboard.payments.toasts.paypalDisabled"),
        description: enabled
          ? t("adminDashboard.payments.toasts.paypalEnabledDesc", { currency: paypalFormData.paypal_currency })
          : t("adminDashboard.payments.toasts.paypalDisabledDesc")
      });
    } catch (error: any) {
      setPaypalEnabled(!enabled);
      justToggledRef.current = false;
      toast({
        title: t("adminDashboard.payments.toasts.paypalToggleFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  };

  const togglePaystackEnabled = async (enabled: boolean) => {
    try {
      justToggledRef.current = true;
      setPaystackEnabled(enabled);
      await updateSettingMutation.mutateAsync({ key: "paystack_enabled", value: enabled });
      toast({
        title: enabled ? t("adminDashboard.payments.toasts.paystackEnabled") : t("adminDashboard.payments.toasts.paystackDisabled"),
        description: enabled
          ? t("adminDashboard.payments.toasts.paystackEnabledDesc", { currency: paystackFormData.paystack_currency })
          : t("adminDashboard.payments.toasts.paystackDisabledDesc")
      });
    } catch (error: any) {
      setPaystackEnabled(!enabled);
      justToggledRef.current = false;
      toast({
        title: t("adminDashboard.payments.toasts.paystackToggleFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  };

  const toggleMercadopagoEnabled = async (enabled: boolean) => {
    try {
      justToggledRef.current = true;
      setMercadopagoEnabled(enabled);
      await updateSettingMutation.mutateAsync({ key: "mercadopago_enabled", value: enabled });
      toast({
        title: enabled ? t("adminDashboard.payments.toasts.mercadopagoEnabled") : t("adminDashboard.payments.toasts.mercadopagoDisabled"),
        description: enabled
          ? t("adminDashboard.payments.toasts.mercadopagoEnabledDesc", { currency: mercadopagoFormData.mercadopago_currency })
          : t("adminDashboard.payments.toasts.mercadopagoDisabledDesc")
      });
    } catch (error: any) {
      setMercadopagoEnabled(!enabled);
      justToggledRef.current = false;
      toast({
        title: t("adminDashboard.payments.toasts.mercadopagoToggleFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  };

  const toggleYookassaEnabled = async (enabled: boolean) => {
    try {
      justToggledRef.current = true;
      setYookassaEnabled(enabled);
      await updateSettingMutation.mutateAsync({ key: "yookassa_enabled", value: enabled });
      toast({
        title: enabled ? t("adminDashboard.payments.toasts.yookassaEnabled") : t("adminDashboard.payments.toasts.yookassaDisabled"),
        description: enabled
          ? t("adminDashboard.payments.toasts.yookassaEnabledDesc", { currency: yookassaFormData.yookassa_currency })
          : t("adminDashboard.payments.toasts.yookassaDisabledDesc")
      });
    } catch (error: any) {
      setYookassaEnabled(!enabled);
      justToggledRef.current = false;
      toast({
        title: t("adminDashboard.payments.toasts.yookassaToggleFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  };

  const lockCurrencyMutation = useMutation({
    mutationFn: async () => {
      // First save the current currency if there are changes
      await updateSettingMutation.mutateAsync({
        key: "stripe_currency",
        value: stripeFormData.stripe_currency
      });
      // Then lock it
      await updateSettingMutation.mutateAsync({
        key: "stripe_currency_locked",
        value: true
      });
    },
    onSuccess: () => {
      setStripeCurrencyLocked(true);
      setShowLockConfirmDialog(false);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/settings"] });
      toast({
        title: t("adminDashboard.payments.toasts.currencyLocked"),
        description: t("adminDashboard.payments.toasts.currencyLockedDesc", { currency: stripeFormData.stripe_currency })
      });
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.payments.toasts.currencyLockFailed"),
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const testStripeConnectionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/test-connection/stripe");
      return response.json();
    },
    onSuccess: (data: ConnectionStatus) => {
      const sanitizedError = sanitizeErrorMessage(data.error, 'Stripe credentials not configured');
      setStripeConnectionStatus({ ...data, error: sanitizedError });
    },
    onError: (error: any) => {
      const sanitizedError = sanitizeErrorMessage(error.message, 'Connection test failed');
      setStripeConnectionStatus({
        connected: false,
        error: sanitizedError || t("adminDashboard.payments.testFailed")
      });
    }
  });

  const testRazorpayConnectionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/test-connection/razorpay");
      return response.json();
    },
    onSuccess: (data: ConnectionStatus) => {
      const sanitizedError = sanitizeErrorMessage(data.error, 'Razorpay credentials not configured');
      setRazorpayConnectionStatus({
        connected: data.connected || false,
        error: sanitizedError
      });
    },
    onError: (error: any) => {
      const sanitizedError = sanitizeErrorMessage(error.message, 'Connection test failed');
      setRazorpayConnectionStatus({
        connected: false,
        error: sanitizedError || t("adminDashboard.payments.testFailed")
      });
    }
  });

  const testRazorpayWebhookMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/test-webhook/razorpay");
      return response.json();
    },
    onSuccess: (data: any) => {
      if (data.success) {
        toast({
          title: t("adminDashboard.payments.razorpay.webhookVerified"),
          description: data.message || t("adminDashboard.payments.razorpay.webhookVerifiedDesc"),
        });
      } else {
        toast({
          title: t("adminDashboard.payments.razorpay.webhookTestFailed"),
          description: data.error || t("adminDashboard.payments.razorpay.webhookTestFailedDesc"),
          variant: "destructive",
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.payments.razorpay.webhookTestFailed"),
        description: error.message || t("adminDashboard.payments.razorpay.webhookTestError"),
        variant: "destructive",
      });
    }
  });

  const testPaypalConnectionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/test-connection/paypal");
      return response.json();
    },
    onSuccess: (data: ConnectionStatus) => {
      const sanitizedError = sanitizeErrorMessage(data.error, 'PayPal credentials not configured');
      setPaypalConnectionStatus({
        connected: data.connected || false,
        mode: data.mode,
        error: sanitizedError
      });
    },
    onError: (error: any) => {
      const sanitizedError = sanitizeErrorMessage(error.message, 'Connection test failed');
      setPaypalConnectionStatus({
        connected: false,
        error: sanitizedError || t("adminDashboard.payments.testFailed")
      });
    }
  });

  const testPaystackConnectionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/test-connection/paystack");
      return response.json();
    },
    onSuccess: (data: ConnectionStatus) => {
      const sanitizedError = sanitizeErrorMessage(data.error, 'Paystack credentials not configured');
      setPaystackConnectionStatus({
        connected: data.connected || false,
        error: sanitizedError
      });
    },
    onError: (error: any) => {
      const sanitizedError = sanitizeErrorMessage(error.message, 'Connection test failed');
      setPaystackConnectionStatus({
        connected: false,
        error: sanitizedError || t("adminDashboard.payments.testFailed")
      });
    }
  });

  const testMercadopagoConnectionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/test-connection/mercadopago");
      return response.json();
    },
    onSuccess: (data: ConnectionStatus) => {
      const sanitizedError = sanitizeErrorMessage(data.error, 'MercadoPago credentials not configured');
      setMercadopagoConnectionStatus({
        connected: data.connected || false,
        error: sanitizedError
      });
    },
    onError: (error: any) => {
      const sanitizedError = sanitizeErrorMessage(error.message, 'Connection test failed');
      setMercadopagoConnectionStatus({
        connected: false,
        error: sanitizedError || t("adminDashboard.payments.testFailed")
      });
    }
  });

  const testYookassaConnectionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/test-connection/yookassa");
      return response.json();
    },
    onSuccess: (data: ConnectionStatus) => {
      const sanitizedError = sanitizeErrorMessage(data.error, 'YooKassa credentials not configured');
      setYookassaConnectionStatus({
        connected: data.connected || false,
        error: sanitizedError
      });
    },
    onError: (error: any) => {
      const sanitizedError = sanitizeErrorMessage(error.message, 'Connection test failed');
      setYookassaConnectionStatus({
        connected: false,
        error: sanitizedError || t("adminDashboard.payments.testFailed")
      });
    }
  });

  // Webhook setup mutations
  const setupPaypalWebhookMutation = useMutation({
    mutationFn: async () => {
      const webhookUrl = `${window.location.origin}/api/paypal/webhook`;
      const response = await apiRequest("POST", "/api/admin/setup-webhook/paypal", { webhookUrl });
      return response.json();
    },
    onSuccess: (data: any) => {
      if (data.success) {
        toast({
          title: t("adminDashboard.payments.paypal.webhookConfigured"),
          description: t("adminDashboard.payments.paypal.webhookCreated", { id: data.webhookId }),
        });
        setPaypalFormData(prev => ({ ...prev, paypal_webhook_id: data.webhookId }));
        queryClient.invalidateQueries({ queryKey: ["/api/admin/settings"] });
      } else {
        toast({
          title: t("adminDashboard.payments.paypal.webhookSetupFailed"),
          description: data.error || t("adminDashboard.payments.paypal.webhookSetupFailedDesc"),
          variant: "destructive"
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.payments.paypal.webhookSetupFailed"),
        description: error.message || t("adminDashboard.payments.paypal.webhookSetupFailedDesc"),
        variant: "destructive"
      });
    }
  });

  const setupMercadopagoWebhookMutation = useMutation({
    mutationFn: async () => {
      const webhookUrl = `${window.location.origin}/api/mercadopago/webhook`;
      const response = await apiRequest("POST", "/api/admin/setup-webhook/mercadopago", { webhookUrl });
      return response.json();
    },
    onSuccess: (data: any) => {
      if (data.success) {
        toast({
          title: t("adminDashboard.payments.mercadopago.webhookConfigured"),
          description: t("adminDashboard.payments.mercadopago.webhookCreated", { id: data.webhookId }),
        });
        queryClient.invalidateQueries({ queryKey: ["/api/admin/settings"] });
      } else {
        toast({
          title: t("adminDashboard.payments.mercadopago.webhookSetupFailed"),
          description: data.error || t("adminDashboard.payments.mercadopago.webhookSetupFailedDesc"),
          variant: "destructive"
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.payments.mercadopago.webhookSetupFailed"),
        description: error.message || t("adminDashboard.payments.mercadopago.webhookSetupFailedDesc"),
        variant: "destructive"
      });
    }
  });

  const handleStripeChange = (key: keyof typeof stripeFormData, value: string) => {
    // Show warning dialog when currency is being changed
    if (key === 'stripe_currency' && value !== stripeFormData.stripe_currency) {
      setPendingCurrencyChange(value);
      setShowCurrencyChangeDialog(true);
      return;
    }

    setStripeFormData({ ...stripeFormData, [key]: value });
    setHasStripeChanges(true);
    setStripeConnectionStatus(null);
  };

  const confirmCurrencyChange = () => {
    if (pendingCurrencyChange) {
      setStripeFormData({ ...stripeFormData, stripe_currency: pendingCurrencyChange });
      setHasStripeChanges(true);
      setStripeConnectionStatus(null);
      setPendingCurrencyChange(null);
      setShowCurrencyChangeDialog(false);

      toast({
        title: t("adminDashboard.payments.toasts.currencyChanged"),
        description: t("adminDashboard.payments.toasts.currencyChangedDesc"),
      });
    }
  };

  const cancelCurrencyChange = () => {
    setPendingCurrencyChange(null);
    setShowCurrencyChangeDialog(false);
  };

  const handleRazorpayChange = (key: keyof typeof razorpayFormData, value: string) => {
    setRazorpayFormData({ ...razorpayFormData, [key]: value });
    setHasRazorpayChanges(true);
    setRazorpayConnectionStatus(null);
  };

  const handlePaypalChange = (key: keyof typeof paypalFormData, value: string) => {
    setPaypalFormData({ ...paypalFormData, [key]: value });
    setHasPaypalChanges(true);
    setPaypalConnectionStatus(null);
  };

  const handlePaystackChange = (key: keyof typeof paystackFormData, value: string) => {
    setPaystackFormData({ ...paystackFormData, [key]: value });
    setHasPaystackChanges(true);
    setPaystackConnectionStatus(null);
  };

  const handleMercadopagoChange = (key: keyof typeof mercadopagoFormData, value: string) => {
    setMercadopagoFormData({ ...mercadopagoFormData, [key]: value });
    setHasMercadopagoChanges(true);
    setMercadopagoConnectionStatus(null);
  };

  const handleYookassaChange = (key: keyof typeof yookassaFormData, value: string) => {
    setYookassaFormData({ ...yookassaFormData, [key]: value });
    setHasYookassaChanges(true);
    setYookassaConnectionStatus(null);
  };

  const isStripeConfigured = settings?.stripe_configured;
  const isRazorpayConfigured = settings?.razorpay_configured;
  const isPaypalConfigured = settings?.paypal_configured;
  const isPaystackConfigured = settings?.paystack_configured;
  const isMercadopagoConfigured = settings?.mercadopago_configured;
  const isYookassaConfigured = settings?.yookassa_configured;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-8">
          <Loader2 className="h-8 w-8 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <PaymentProvidersOverviewCard
        t={t}
        stripeCurrencyLocked={stripeCurrencyLocked}
        stripeFormData={stripeFormData}
        isStripeConfigured={isStripeConfigured}
        stripeEnabled={stripeEnabled}
        toggleStripeEnabled={toggleStripeEnabled}
        updateSettingMutation={updateSettingMutation}
        isRazorpayConfigured={isRazorpayConfigured}
        razorpayEnabled={razorpayEnabled}
        toggleRazorpayEnabled={toggleRazorpayEnabled}
        paypalFormData={paypalFormData}
        isPaypalConfigured={isPaypalConfigured}
        paypalEnabled={paypalEnabled}
        togglePaypalEnabled={togglePaypalEnabled}
        paystackFormData={paystackFormData}
        isPaystackConfigured={isPaystackConfigured}
        paystackEnabled={paystackEnabled}
        togglePaystackEnabled={togglePaystackEnabled}
        mercadopagoFormData={mercadopagoFormData}
        isMercadopagoConfigured={isMercadopagoConfigured}
        mercadopagoEnabled={mercadopagoEnabled}
        toggleMercadopagoEnabled={toggleMercadopagoEnabled}
        yookassaFormData={yookassaFormData}
        isYookassaConfigured={isYookassaConfigured}
        yookassaEnabled={yookassaEnabled}
        toggleYookassaEnabled={toggleYookassaEnabled}
      />

      {/* Payment Redirect URLs Info Card */}
      <PaymentRedirectUrlsCard
        t={t}
        toast={toast}
      />

      <Tabs defaultValue="stripe" className="space-y-4">
        <div className="overflow-x-auto -mx-1 px-1">
          <TabsList className="inline-flex w-auto min-w-full md:grid md:w-full md:grid-cols-6">
            <TabsTrigger value="stripe" className="flex items-center gap-1 md:gap-2 whitespace-nowrap px-3" data-testid="tab-stripe">
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z" />
              </svg>
              <span className="hidden sm:inline">{t("adminDashboard.payments.tabs.stripe")}</span>
              {isStripeConfigured && <Badge variant="outline" className="ml-1 text-xs hidden lg:inline-flex">{t("adminDashboard.payments.gatewayAvailability.configured")}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="razorpay" className="flex items-center gap-1 md:gap-2 whitespace-nowrap px-3" data-testid="tab-razorpay">
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.436 0l-11.91 7.773-1.174 4.276 6.625-4.297L11.65 24h4.391l6.395-24zM14.26 10.098L3.389 17.166 1.564 24h9.508l3.188-13.902z" />
              </svg>
              <span className="hidden sm:inline">{t("adminDashboard.payments.tabs.razorpay")}</span>
              {isRazorpayConfigured && <Badge variant="outline" className="ml-1 text-xs hidden lg:inline-flex">{t("adminDashboard.payments.gatewayAvailability.configured")}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="paypal" className="flex items-center gap-1 md:gap-2 whitespace-nowrap px-3" data-testid="tab-paypal">
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944.901C5.026.382 5.474 0 5.998 0h7.46c2.57 0 4.578.543 5.69 1.81 1.01 1.15 1.304 2.42 1.012 4.287-.023.143-.047.288-.077.437-.983 5.05-4.349 6.797-8.647 6.797h-2.19c-.524 0-.968.382-1.05.9l-1.12 7.106zm14.146-14.42a3.35 3.35 0 0 0-.607-.541c-.013.076-.026.175-.041.254-.59 3.025-2.566 6.082-8.558 6.082h-2.19c-1.049 0-1.968.757-2.099 1.798l-1.12 7.106a.64.64 0 0 0 .633.739h3.553c.525 0 .969-.382 1.05-.901l.776-4.909c.082-.519.526-.901 1.05-.901h.658c4.299 0 7.665-1.747 8.648-6.797.324-1.664.18-3.022-.753-3.93z" />
              </svg>
              <span className="hidden sm:inline">{t("adminDashboard.payments.tabs.paypal")}</span>
              {isPaypalConfigured && <Badge variant="outline" className="ml-1 text-xs hidden lg:inline-flex">{t("adminDashboard.payments.gatewayAvailability.configured")}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="paystack" className="flex items-center gap-1 md:gap-2 whitespace-nowrap px-3" data-testid="tab-paystack">
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.604 10.89h18.792a.396.396 0 0 0 .396-.396V7.286a.396.396 0 0 0-.396-.396H2.604a.396.396 0 0 0-.396.396v3.208c0 .218.178.396.396.396zm0 6.22h18.792a.396.396 0 0 0 .396-.396v-3.208a.396.396 0 0 0-.396-.396H2.604a.396.396 0 0 0-.396.396v3.208c0 .218.178.396.396.396zm0-12.22h18.792a.396.396 0 0 0 .396-.396V1.286a.396.396 0 0 0-.396-.396H2.604a.396.396 0 0 0-.396.396v3.208c0 .218.178.396.396.396zm0 18h11.188a.396.396 0 0 0 .396-.396v-3.208a.396.396 0 0 0-.396-.396H2.604a.396.396 0 0 0-.396.396v3.208c0 .218.178.396.396.396z" />
              </svg>
              <span className="hidden sm:inline">{t("adminDashboard.payments.tabs.paystack")}</span>
              {isPaystackConfigured && <Badge variant="outline" className="ml-1 text-xs hidden lg:inline-flex">{t("adminDashboard.payments.gatewayAvailability.configured")}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="mercadopago" className="flex items-center gap-1 md:gap-2 whitespace-nowrap px-3" data-testid="tab-mercadopago">
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 4.8c3.974 0 7.2 3.226 7.2 7.2s-3.226 7.2-7.2 7.2-7.2-3.226-7.2-7.2S8.026 4.8 12 4.8zm0 1.8a5.4 5.4 0 1 0 0 10.8 5.4 5.4 0 0 0 0-10.8zm0 2.4a3 3 0 1 1 0 6 3 3 0 0 1 0-6z" />
              </svg>
              <span className="hidden sm:inline">{t("adminDashboard.payments.tabs.mercadopago")}</span>
              {isMercadopagoConfigured && <Badge variant="outline" className="ml-1 text-xs hidden lg:inline-flex">{t("adminDashboard.payments.gatewayAvailability.configured")}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="yookassa" className="flex items-center gap-1 md:gap-2 whitespace-nowrap px-3" data-testid="tab-yookassa">
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <line x1="2" y1="10" x2="22" y2="10" />
              </svg>
              <span className="hidden sm:inline">{t("adminDashboard.payments.tabs.yookassa")}</span>
              {isYookassaConfigured && <Badge variant="outline" className="ml-1 text-xs hidden lg:inline-flex">{t("adminDashboard.payments.gatewayAvailability.configured")}</Badge>}
            </TabsTrigger>
          </TabsList>
        </div>

        <StripeSettingsTab
          t={t}
          isStripeConfigured={isStripeConfigured}
          stripeConnectionStatus={stripeConnectionStatus}
          settings={settings}
          showStripeSecretKey={showStripeSecretKey}
          stripeFormData={stripeFormData}
          handleStripeChange={handleStripeChange}
          setShowStripeSecretKey={setShowStripeSecretKey}
          showStripeWebhookSecret={showStripeWebhookSecret}
          setShowStripeWebhookSecret={setShowStripeWebhookSecret}
          stripeCurrencyLocked={stripeCurrencyLocked}
          showLockConfirmDialog={showLockConfirmDialog}
          setShowLockConfirmDialog={setShowLockConfirmDialog}
          lockCurrencyMutation={lockCurrencyMutation}
          toast={toast}
          testStripeConnectionMutation={testStripeConnectionMutation}
          saveStripeSettings={saveStripeSettings}
          hasStripeChanges={hasStripeChanges}
          updateSettingMutation={updateSettingMutation}
        />

        <RazorpaySettingsTab
          t={t}
          isRazorpayConfigured={isRazorpayConfigured}
          razorpayConnectionStatus={razorpayConnectionStatus}
          settings={settings}
          razorpayFormData={razorpayFormData}
          handleRazorpayChange={handleRazorpayChange}
          showRazorpayKeySecret={showRazorpayKeySecret}
          setShowRazorpayKeySecret={setShowRazorpayKeySecret}
          showRazorpayWebhookSecret={showRazorpayWebhookSecret}
          setShowRazorpayWebhookSecret={setShowRazorpayWebhookSecret}
          testRazorpayWebhookMutation={testRazorpayWebhookMutation}
          toast={toast}
          testRazorpayConnectionMutation={testRazorpayConnectionMutation}
          saveRazorpaySettings={saveRazorpaySettings}
          hasRazorpayChanges={hasRazorpayChanges}
          updateSettingMutation={updateSettingMutation}
        />

        <PaypalSettingsTab
          t={t}
          isPaypalConfigured={isPaypalConfigured}
          paypalConnectionStatus={paypalConnectionStatus}
          settings={settings}
          paypalFormData={paypalFormData}
          handlePaypalChange={handlePaypalChange}
          showPaypalClientSecret={showPaypalClientSecret}
          setShowPaypalClientSecret={setShowPaypalClientSecret}
          toast={toast}
          setupPaypalWebhookMutation={setupPaypalWebhookMutation}
          testPaypalConnectionMutation={testPaypalConnectionMutation}
          savePaypalSettings={savePaypalSettings}
          hasPaypalChanges={hasPaypalChanges}
          updateSettingMutation={updateSettingMutation}
        />

        <PaystackSettingsTab
          t={t}
          isPaystackConfigured={isPaystackConfigured}
          paystackConnectionStatus={paystackConnectionStatus}
          settings={settings}
          paystackFormData={paystackFormData}
          handlePaystackChange={handlePaystackChange}
          showPaystackSecretKey={showPaystackSecretKey}
          setShowPaystackSecretKey={setShowPaystackSecretKey}
          showPaystackWebhookSecret={showPaystackWebhookSecret}
          setShowPaystackWebhookSecret={setShowPaystackWebhookSecret}
          toast={toast}
          testPaystackConnectionMutation={testPaystackConnectionMutation}
          savePaystackSettings={savePaystackSettings}
          hasPaystackChanges={hasPaystackChanges}
          updateSettingMutation={updateSettingMutation}
        />

        <MercadopagoSettingsTab
          t={t}
          isMercadopagoConfigured={isMercadopagoConfigured}
          mercadopagoConnectionStatus={mercadopagoConnectionStatus}
          settings={settings}
          mercadopagoFormData={mercadopagoFormData}
          handleMercadopagoChange={handleMercadopagoChange}
          showMercadopagoAccessToken={showMercadopagoAccessToken}
          setShowMercadopagoAccessToken={setShowMercadopagoAccessToken}
          showMercadopagoWebhookSecret={showMercadopagoWebhookSecret}
          setShowMercadopagoWebhookSecret={setShowMercadopagoWebhookSecret}
          toast={toast}
          setupMercadopagoWebhookMutation={setupMercadopagoWebhookMutation}
          testMercadopagoConnectionMutation={testMercadopagoConnectionMutation}
          saveMercadopagoSettings={saveMercadopagoSettings}
          hasMercadopagoChanges={hasMercadopagoChanges}
          updateSettingMutation={updateSettingMutation}
        />

        <YookassaSettingsTab
          t={t}
          isYookassaConfigured={isYookassaConfigured}
          yookassaConnectionStatus={yookassaConnectionStatus}
          settings={settings}
          yookassaFormData={yookassaFormData}
          handleYookassaChange={handleYookassaChange}
          showYookassaSecretKey={showYookassaSecretKey}
          setShowYookassaSecretKey={setShowYookassaSecretKey}
          showYookassaWebhookSecret={showYookassaWebhookSecret}
          setShowYookassaWebhookSecret={setShowYookassaWebhookSecret}
          toast={toast}
          testYookassaConnectionMutation={testYookassaConnectionMutation}
          saveYookassaSettings={saveYookassaSettings}
          hasYookassaChanges={hasYookassaChanges}
          updateSettingMutation={updateSettingMutation}
        />
      </Tabs>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <DollarSign className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle>{t("adminDashboard.payments.currencyInfo")}</CardTitle>
              <CardDescription>{t("adminDashboard.payments.currencyInfoDesc")}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {t("adminDashboard.payments.currencyInfoBody")}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Currency Change Warning Dialog */}
      <CurrencyChangeDialog
        showCurrencyChangeDialog={showCurrencyChangeDialog}
        setShowCurrencyChangeDialog={setShowCurrencyChangeDialog}
        t={t}
        stripeFormData={stripeFormData}
        pendingCurrencyChange={pendingCurrencyChange}
        cancelCurrencyChange={cancelCurrencyChange}
        confirmCurrencyChange={confirmCurrencyChange}
      />
    </div>
  );
}
