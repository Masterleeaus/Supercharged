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
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect, useRef } from "react";
import { CreditCard, Save, Loader2, CheckCircle, XCircle, AlertCircle, TestTube, Eye, EyeOff, DollarSign, ToggleLeft, ToggleRight, Lock, LockOpen, AlertTriangle, Webhook, Copy } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface ConnectionStatus {
  connected: boolean;
  mode?: string;
  currency?: string;
  availableBalance?: string;
  source?: string;
  error?: string;
  success?: boolean;
}

/**
 * Sanitize error messages to prevent displaying raw HTML or overly technical errors
 * Returns a clean, user-friendly error message
 */
function sanitizeErrorMessage(error: string | undefined, fallbackMessage: string): string | undefined {
  if (!error) return undefined;

  // Detect HTML content (like 502 Bad Gateway pages)
  if (error.includes('<html') || error.includes('<!DOCTYPE') || error.includes('<head>') || error.includes('<body>')) {
    return 'Service temporarily unavailable. Please check your server configuration.';
  }

  // Detect JSON parsing errors (indicates server returned non-JSON)
  if (error.includes('Unexpected token') || error.includes('JSON')) {
    return 'Service temporarily unavailable. Please check your server configuration.';
  }

  // Detect network/connection errors
  if (error.includes('Failed to fetch') || error.includes('NetworkError') || error.includes('ECONNREFUSED')) {
    return 'Unable to connect to server. Please check if the service is running.';
  }

  // If error is too long (likely contains debug info), truncate it
  if (error.length > 200) {
    return fallbackMessage;
  }

  return error;
}

const CURRENCIES = [
  { code: "USD", symbol: "$", name: "US Dollar" },
  { code: "EUR", symbol: "€", name: "Euro" },
  { code: "GBP", symbol: "£", name: "British Pound" },
  { code: "CAD", symbol: "$", name: "Canadian Dollar" },
  { code: "AUD", symbol: "$", name: "Australian Dollar" },
  { code: "JPY", symbol: "¥", name: "Japanese Yen" },
  { code: "INR", symbol: "₹", name: "Indian Rupee" },
  { code: "BRL", symbol: "R$", name: "Brazilian Real" },
  { code: "MXN", symbol: "$", name: "Mexican Peso" },
  { code: "CHF", symbol: "CHF", name: "Swiss Franc" },
];

const PAYPAL_CURRENCIES = [
  { code: "USD", symbol: "$", name: "US Dollar" },
  { code: "EUR", symbol: "€", name: "Euro" },
  { code: "GBP", symbol: "£", name: "British Pound" },
  { code: "AUD", symbol: "A$", name: "Australian Dollar" },
  { code: "CAD", symbol: "C$", name: "Canadian Dollar" },
];

const PAYSTACK_CURRENCIES = [
  { code: "NGN", symbol: "₦", name: "Nigerian Naira" },
  { code: "GHS", symbol: "GH₵", name: "Ghanaian Cedi" },
  { code: "ZAR", symbol: "R", name: "South African Rand" },
  { code: "KES", symbol: "KSh", name: "Kenyan Shilling" },
  { code: "USD", symbol: "$", name: "US Dollar" },
];

const MERCADOPAGO_CURRENCIES = [
  { code: "BRL", symbol: "R$", name: "Brazilian Real" },
  { code: "ARS", symbol: "$", name: "Argentine Peso" },
  { code: "MXN", symbol: "MX$", name: "Mexican Peso" },
  { code: "CLP", symbol: "$", name: "Chilean Peso" },
  { code: "COP", symbol: "$", name: "Colombian Peso" },
];

const YOOKASSA_CURRENCIES = [
  { code: "RUB", symbol: "₽", name: "Russian Ruble" },
  { code: "USD", symbol: "$", name: "US Dollar" },
  { code: "EUR", symbol: "€", name: "Euro" },
];

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

      {/* Payment Redirect URLs Info Card */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center gap-3">
            <Webhook className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">{t("adminDashboard.payments.redirectUrls.title")}</CardTitle>
              <CardDescription>{t("adminDashboard.payments.redirectUrls.description")}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 p-3 bg-muted/50 rounded-lg border">
              <Label className="text-xs font-medium text-muted-foreground">{t("adminDashboard.payments.redirectUrls.successLabel")}</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-sm font-mono text-foreground truncate bg-background px-2 py-1 rounded border">
                  {window.location.origin}/app/billing?success=true
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/app/billing?success=true`);
                    toast({ title: t("adminDashboard.payments.redirectUrls.copied"), description: t("adminDashboard.payments.redirectUrls.successUrlCopied") });
                  }}
                  data-testid="button-copy-success-url"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.redirectUrls.successHint")}</p>
            </div>
            <div className="space-y-2 p-3 bg-muted/50 rounded-lg border">
              <Label className="text-xs font-medium text-muted-foreground">{t("adminDashboard.payments.redirectUrls.cancelLabel")}</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-sm font-mono text-foreground truncate bg-background px-2 py-1 rounded border">
                  {window.location.origin}/app/billing?cancelled=true
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/app/billing?cancelled=true`);
                    toast({ title: t("adminDashboard.payments.redirectUrls.copied"), description: t("adminDashboard.payments.redirectUrls.cancelUrlCopied") });
                  }}
                  data-testid="button-copy-cancel-url"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.redirectUrls.cancelHint")}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("adminDashboard.payments.redirectUrls.note")}
          </p>
        </CardContent>
      </Card>

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

        <TabsContent value="paypal">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CreditCard className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <CardTitle>{t("adminDashboard.payments.paypal.title")}</CardTitle>
                    <CardDescription>{t("adminDashboard.payments.paypal.description")}</CardDescription>
                  </div>
                </div>
                {isPaypalConfigured && (
                  <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    {t("adminDashboard.payments.gatewayAvailability.configured")}
                  </Badge>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-6">
              {paypalConnectionStatus && (
                <Alert variant={paypalConnectionStatus.connected ? "default" : "destructive"}>
                  {paypalConnectionStatus.connected ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  <AlertDescription>
                    {paypalConnectionStatus.connected ? (
                      <div className="space-y-1">
                        <p>{t("adminDashboard.payments.paypal.connectionSuccess")}</p>
                        {paypalConnectionStatus.mode && (
                          <p className="text-sm text-muted-foreground">
                            {t("adminDashboard.payments.mode")}: <strong>{paypalConnectionStatus.mode.toUpperCase()}</strong>
                          </p>
                        )}
                      </div>
                    ) : (
                      paypalConnectionStatus.error || t("adminDashboard.payments.paypal.connectionFailed")
                    )}
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="paypal_client_id">{t("adminDashboard.payments.paypal.clientId")}</Label>
                    {settings?.paypal_client_id && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <Input
                    id="paypal_client_id"
                    type="text"
                    value={paypalFormData.paypal_client_id}
                    onChange={(e) => handlePaypalChange("paypal_client_id", e.target.value)}
                    placeholder="Enter your PayPal Client ID"
                    data-testid="input-paypal-client-id"
                  />
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paypal.clientIdHint")}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="paypal_client_secret">{t("adminDashboard.payments.paypal.clientSecret")}</Label>
                    {settings?.paypal_client_secret && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                    <Input
                      id="paypal_client_secret"
                      type={showPaypalClientSecret ? "text" : "password"}
                      value={paypalFormData.paypal_client_secret}
                      onChange={(e) => handlePaypalChange("paypal_client_secret", e.target.value)}
                      placeholder={settings?.paypal_client_secret ? "Enter new secret to replace existing..." : "Enter your client secret"}
                      className="border-0 shadow-none focus-visible:ring-0 flex-1"
                      data-testid="input-paypal-client-secret"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setShowPaypalClientSecret(!showPaypalClientSecret)}
                      data-testid="button-toggle-paypal-secret"
                    >
                      {showPaypalClientSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paypal.clientSecretHint")}</p>
                </div>

                <div className="space-y-2 p-4 bg-muted/50 rounded-lg border">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Webhook className="h-4 w-4 text-muted-foreground" />
                      <Label className="font-medium">{t("adminDashboard.payments.paypal.webhookConfig")}</Label>
                    </div>
                    {settings?.paypal_webhook_id && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>

                  {settings?.paypal_webhook_id ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-2 bg-background rounded border text-sm font-mono break-all">
                          {window.location.origin}/api/paypal/webhook
                        </code>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => {
                            navigator.clipboard.writeText(`${window.location.origin}/api/paypal/webhook`);
                            toast({
                              title: t("adminDashboard.payments.redirectUrls.copied"),
                              description: t("adminDashboard.payments.paypal.webhookCopied"),
                            });
                          }}
                          data-testid="button-copy-paypal-webhook"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t("adminDashboard.payments.paypal.webhookId", { id: settings.paypal_webhook_id })}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setupPaypalWebhookMutation.mutate()}
                        disabled={setupPaypalWebhookMutation.isPending || !isPaypalConfigured}
                        data-testid="button-reconfigure-paypal-webhook"
                      >
                        {setupPaypalWebhookMutation.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Webhook className="h-4 w-4 mr-2" />
                        )}
                        {t("adminDashboard.payments.paypal.reconfigure")}
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        {t("adminDashboard.payments.paypal.webhookSetupInstructions")}
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-2 bg-background rounded border text-sm font-mono break-all">
                          {window.location.origin}/api/paypal/webhook
                        </code>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => {
                            navigator.clipboard.writeText(`${window.location.origin}/api/paypal/webhook`);
                            toast({
                              title: t("adminDashboard.payments.redirectUrls.copied"),
                              description: t("adminDashboard.payments.paypal.webhookCopied"),
                            });
                          }}
                          data-testid="button-copy-paypal-webhook"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      <Button
                        type="button"
                        onClick={() => setupPaypalWebhookMutation.mutate()}
                        disabled={setupPaypalWebhookMutation.isPending || !isPaypalConfigured}
                        data-testid="button-setup-paypal-webhook"
                      >
                        {setupPaypalWebhookMutation.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Webhook className="h-4 w-4 mr-2" />
                        )}
                        {t("adminDashboard.payments.paypal.setupAutomatically")}
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        {t("adminDashboard.payments.paypal.setupNote")}
                      </p>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="paypal_currency">{t("adminDashboard.payments.paypal.currency")}</Label>
                    <Select
                      value={paypalFormData.paypal_currency}
                      onValueChange={(value) => handlePaypalChange("paypal_currency", value)}
                    >
                      <SelectTrigger data-testid="select-paypal-currency">
                        <SelectValue placeholder={t("adminDashboard.payments.stripe.selectCurrency")} />
                      </SelectTrigger>
                      <SelectContent>
                        {PAYPAL_CURRENCIES.map((currency) => (
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
                    <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paypal.currencyHint")}</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="paypal_mode">{t("adminDashboard.payments.paypal.mode")}</Label>
                    <Select
                      value={paypalFormData.paypal_mode}
                      onValueChange={(value) => handlePaypalChange("paypal_mode", value)}
                    >
                      <SelectTrigger data-testid="select-paypal-mode">
                        <SelectValue placeholder={t("adminDashboard.payments.selectMode")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sandbox">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20">
                              {t("adminDashboard.payments.paypal.sandbox")}
                            </Badge>
                            <span className="text-muted-foreground">{t("adminDashboard.payments.paypal.testMode")}</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="live">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                              {t("adminDashboard.payments.paypal.live")}
                            </Badge>
                            <span className="text-muted-foreground">{t("adminDashboard.payments.paypal.productionMode")}</span>
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </CardContent>

            <CardFooter className="flex justify-between gap-2 flex-wrap">
              <Button
                variant="outline"
                onClick={() => testPaypalConnectionMutation.mutate()}
                disabled={testPaypalConnectionMutation.isPending}
                data-testid="button-test-paypal"
              >
                {testPaypalConnectionMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <TestTube className="h-4 w-4 mr-2" />
                )}
                {t("adminDashboard.payments.testConnection")}
              </Button>
              <Button
                onClick={savePaypalSettings}
                disabled={!hasPaypalChanges || updateSettingMutation.isPending}
                data-testid="button-save-paypal"
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

        <TabsContent value="paystack">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CreditCard className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <CardTitle>{t("adminDashboard.payments.paystack.title")}</CardTitle>
                    <CardDescription>{t("adminDashboard.payments.paystack.description")}</CardDescription>
                  </div>
                </div>
                {isPaystackConfigured && (
                  <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    {t("adminDashboard.payments.gatewayAvailability.configured")}
                  </Badge>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-6">
              {paystackConnectionStatus && (
                <Alert variant={paystackConnectionStatus.connected ? "default" : "destructive"}>
                  {paystackConnectionStatus.connected ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  <AlertDescription>
                    {paystackConnectionStatus.connected
                      ? t("adminDashboard.payments.paystack.connectionSuccess")
                      : paystackConnectionStatus.error || t("adminDashboard.payments.paystack.connectionFailed")
                    }
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="paystack_public_key">{t("adminDashboard.payments.paystack.publicKey")}</Label>
                    {settings?.paystack_public_key && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <Input
                    id="paystack_public_key"
                    type="text"
                    value={paystackFormData.paystack_public_key}
                    onChange={(e) => handlePaystackChange("paystack_public_key", e.target.value)}
                    placeholder="pk_test_..."
                    data-testid="input-paystack-public-key"
                  />
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paystack.publicKeyHint")}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="paystack_secret_key">{t("adminDashboard.payments.paystack.secretKey")}</Label>
                    {settings?.paystack_secret_key && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                    <Input
                      id="paystack_secret_key"
                      type={showPaystackSecretKey ? "text" : "password"}
                      value={paystackFormData.paystack_secret_key}
                      onChange={(e) => handlePaystackChange("paystack_secret_key", e.target.value)}
                      placeholder={settings?.paystack_secret_key ? "Enter new secret to replace existing..." : "Enter your secret key"}
                      className="border-0 shadow-none focus-visible:ring-0 flex-1"
                      data-testid="input-paystack-secret-key"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setShowPaystackSecretKey(!showPaystackSecretKey)}
                      data-testid="button-toggle-paystack-secret"
                    >
                      {showPaystackSecretKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paystack.secretKeyHint")}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="paystack_webhook_secret">{t("adminDashboard.payments.paystack.webhookSecret")}</Label>
                    {settings?.paystack_webhook_secret && (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("adminDashboard.payments.gatewayAvailability.configured")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                    <Input
                      id="paystack_webhook_secret"
                      type={showPaystackWebhookSecret ? "text" : "password"}
                      value={paystackFormData.paystack_webhook_secret}
                      onChange={(e) => handlePaystackChange("paystack_webhook_secret", e.target.value)}
                      placeholder={settings?.paystack_webhook_secret ? "Enter new secret to replace existing..." : "Enter webhook secret"}
                      className="border-0 shadow-none focus-visible:ring-0 flex-1"
                      data-testid="input-paystack-webhook-secret"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setShowPaystackWebhookSecret(!showPaystackWebhookSecret)}
                      data-testid="button-toggle-paystack-webhook-secret"
                    >
                      {showPaystackWebhookSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paystack.webhookSecretHint")}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="paystack_currency">{t("adminDashboard.payments.paystack.currency")}</Label>
                  <Select
                    value={paystackFormData.paystack_currency}
                    onValueChange={(value) => handlePaystackChange("paystack_currency", value)}
                  >
                    <SelectTrigger data-testid="select-paystack-currency">
                      <SelectValue placeholder={t("adminDashboard.payments.stripe.selectCurrency")} />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYSTACK_CURRENCIES.map((currency) => (
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
                  <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paystack.currencyHint")}</p>
                </div>

                <div className="space-y-2 p-4 bg-muted/50 rounded-lg border">
                  <div className="flex items-center gap-2">
                    <Webhook className="h-4 w-4 text-muted-foreground" />
                    <Label className="font-medium">{t("adminDashboard.payments.paystack.webhookUrl")}</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 bg-background rounded border text-sm font-mono break-all">
                      {window.location.origin}/api/paystack/webhook
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        navigator.clipboard.writeText(`${window.location.origin}/api/paystack/webhook`);
                        toast({
                          title: t("adminDashboard.payments.redirectUrls.copied"),
                          description: t("adminDashboard.payments.paystack.webhookCopied"),
                        });
                      }}
                      data-testid="button-copy-paystack-webhook"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="space-y-2 mt-3">
                    <p className="text-xs text-muted-foreground">{t("adminDashboard.payments.paystack.webhookUrlHint")}</p>
                    <p className="text-xs text-muted-foreground font-medium">{t("adminDashboard.payments.paystack.enableEvents")}</p>
                    <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                      <li>charge.success</li>
                      <li>subscription.create</li>
                      <li>subscription.disable</li>
                      <li>subscription.not_renew</li>
                    </ul>
                  </div>
                </div>
              </div>

              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {t("adminDashboard.payments.paystack.alert")}
                </AlertDescription>
              </Alert>
            </CardContent>

            <CardFooter className="flex justify-between gap-2 flex-wrap">
              <Button
                variant="outline"
                onClick={() => testPaystackConnectionMutation.mutate()}
                disabled={testPaystackConnectionMutation.isPending}
                data-testid="button-test-paystack"
              >
                {testPaystackConnectionMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <TestTube className="h-4 w-4 mr-2" />
                )}
                {t("adminDashboard.payments.testConnection")}
              </Button>
              <Button
                onClick={savePaystackSettings}
                disabled={!hasPaystackChanges || updateSettingMutation.isPending}
                data-testid="button-save-paystack"
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
      <AlertDialog open={showCurrencyChangeDialog} onOpenChange={setShowCurrencyChangeDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              {t("adminDashboard.payments.changeCurrency.title")}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  {t("adminDashboard.payments.changeCurrency.body", { from: stripeFormData.stripe_currency, to: pendingCurrencyChange })}
                </p>
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3">
                  <p className="font-medium text-amber-600 dark:text-amber-400">
                    {t("adminDashboard.payments.changeCurrency.warningTitle")}
                  </p>
                  <p className="mt-1">
                    {t("adminDashboard.payments.changeCurrency.warningBody")}
                  </p>
                </div>
                <p>
                  {t("adminDashboard.payments.changeCurrency.note")}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelCurrencyChange}>{t("adminDashboard.payments.changeCurrency.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCurrencyChange}
              className="bg-amber-600 hover:bg-amber-700"
            >
              <DollarSign className="h-4 w-4 mr-2" />
              {t("adminDashboard.payments.changeCurrency.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
