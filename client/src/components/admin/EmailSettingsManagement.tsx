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
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Mail, CheckCircle, AlertCircle, Loader2, Edit, UserPlus, Crown, CreditCard, Phone, AlertTriangle, CheckCircle2, XCircle, Send, ShieldCheck, ShieldX, type LucideIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmailTemplateEditor } from "./EmailTemplateEditor";

interface EmailNotificationSetting {
  id: string;
  eventType: string;
  displayName: string;
  description: string | null;
  isEnabled: boolean;
  category: string;
  thresholdValue: number | null;
  updatedAt: string;
}

interface EmailTemplate {
  id: string;
  templateType: string;
  name: string;
  subject: string;
  htmlBody: string;
  textBody: string | null;
  variables: string[] | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SmtpStatus {
  configured: boolean;
  host: string | null;
  port: number | null;
  user: string | null;
  hasPassword: boolean;
  missingFields: string[];
}

interface EmailSettingsResponse {
  settings: EmailNotificationSetting[];
  smtpConfigured: boolean;
  smtpStatus?: SmtpStatus;
}

interface SmtpTestResult {
  success: boolean;
  message?: string;
  error?: string;
  code?: string;
  host?: string;
  port?: number;
  missingFields?: string[];
}

interface EmailSettingConfig {
  eventType: string;
  templateType: string;
  icon: LucideIcon;
  category: string;
}

const EMAIL_SETTING_CONFIGS: EmailSettingConfig[] = [
  { eventType: "welcomeEmail", templateType: "welcome", icon: UserPlus, category: "authentication" },
  { eventType: "purchaseConfirmation", templateType: "purchase_confirmation", icon: CreditCard, category: "billing" },
  { eventType: "lowCredits", templateType: "low_credits", icon: AlertTriangle, category: "billing" },
  { eventType: "campaignCompleted", templateType: "campaign_completed", icon: CheckCircle2, category: "campaigns" },
  { eventType: "renewalReminder", templateType: "renewal_reminder", icon: Crown, category: "billing" },
  { eventType: "paymentFailed", templateType: "payment_failed", icon: XCircle, category: "billing" },
  { eventType: "accountSuspended", templateType: "account_suspended", icon: AlertCircle, category: "account" },
  { eventType: "accountReactivated", templateType: "account_reactivated", icon: CheckCircle, category: "account" },
  { eventType: "membershipUpgrade", templateType: "membership_upgrade", icon: Crown, category: "billing" },
  { eventType: "phoneNumberBilling", templateType: "phone_billing", icon: Phone, category: "billing" },
  { eventType: "kycApproved", templateType: "kyc_approved", icon: ShieldCheck, category: "kyc" },
  { eventType: "kycRejected", templateType: "kyc_rejected", icon: ShieldX, category: "kyc" },
];

const CATEGORY_ORDER = ["authentication", "billing", "campaigns", "account", "kyc", "general"];

export default function EmailSettingsManagement() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(null);
  const [editingTemplateType, setEditingTemplateType] = useState<string | undefined>(undefined);
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [smtpTestResult, setSmtpTestResult] = useState<SmtpTestResult | null>(null);

  const { data, isLoading, error } = useQuery<EmailSettingsResponse>({
    queryKey: ["/api/admin/email-settings"],
  });

  const testSmtpMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/email-settings/test-smtp");
      if (!response.ok) {
        throw new Error("Failed to test SMTP connection");
      }
      return response.json() as Promise<SmtpTestResult>;
    },
    onSuccess: (result) => {
      setSmtpTestResult(result);
      toast({
        title: result.success ? t("adminDashboard.emailSettings.toasts.smtpTestPassed") : t("adminDashboard.emailSettings.toasts.smtpTestFailed"),
        description: result.success ? result.message : result.error,
        variant: result.success ? "default" : "destructive",
      });
    },
    onError: (error: Error) => {
      setSmtpTestResult({ success: false, error: error.message });
      toast({
        title: t("adminDashboard.emailSettings.toasts.smtpTestFailed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const { data: emailTemplates } = useQuery<EmailTemplate[]>({
    queryKey: ["/api/admin/email-templates"],
  });

  const updateSettingMutation = useMutation({
    mutationFn: async ({ eventType, isEnabled }: { eventType: string; isEnabled: boolean }) => {
      const response = await apiRequest("PUT", `/api/admin/email-settings/${eventType}`, { isEnabled });
      if (!response.ok) {
        throw new Error("Failed to update setting");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/email-settings"] });
      toast({
        title: t("adminDashboard.emailSettings.toasts.settingUpdated"),
        description: t("adminDashboard.emailSettings.toasts.settingUpdatedDesc"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("adminDashboard.emailSettings.toasts.updateFailed"),
        description: error.message || t("adminDashboard.emailSettings.toasts.updateFailedDesc"),
        variant: "destructive",
      });
    },
  });

  const handleToggle = (eventType: string, currentValue: boolean) => {
    updateSettingMutation.mutate({ eventType, isEnabled: !currentValue });
  };

  const handleEditTemplate = (templateType: string) => {
    const template = emailTemplates?.find(t => t.templateType === templateType);
    if (template) {
      setEditingTemplate(template);
      setEditingTemplateType(undefined);
    } else {
      setEditingTemplate(null);
      setEditingTemplateType(templateType);
    }
    setShowTemplateEditor(true);
  };

  const getSettingByEventType = (eventType: string): EmailNotificationSetting | undefined => {
    return data?.settings.find(s => s.eventType === eventType);
  };

  const getTemplateByType = (templateType: string): EmailTemplate | undefined => {
    return emailTemplates?.find(t => t.templateType === templateType);
  };

  const groupConfigsByCategory = () => {
    const grouped: Record<string, EmailSettingConfig[]> = {};
    
    for (const config of EMAIL_SETTING_CONFIGS) {
      const category = config.category || "general";
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(config);
    }
    
    return CATEGORY_ORDER
      .filter(cat => grouped[cat]?.length > 0)
      .map(cat => ({ category: cat, configs: grouped[cat] }));
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-8">
          <Loader2 className="h-8 w-8 animate-spin" data-testid="loading-spinner" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    const errorData = (error as any)?.response?.data;
    let errorMessage = t("adminDashboard.emailSettings.errors.loadFailed");
    
    if (errorData?.code === 'DATABASE_CONNECTION_ERROR') {
      errorMessage = t("adminDashboard.emailSettings.errors.dbConnection");
    } else if (errorData?.code === 'DATABASE_MIGRATION_REQUIRED') {
      errorMessage = t("adminDashboard.emailSettings.errors.dbMigration");
    } else if (errorData?.error) {
      errorMessage = errorData.error;
    }
    
    return (
      <Card>
        <CardContent className="p-6">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const groupedConfigs = groupConfigsByCategory();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Mail className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle>{t("adminDashboard.emailSettings.title")}</CardTitle>
              <CardDescription>{t("adminDashboard.emailSettings.description")}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="p-4 rounded-lg border bg-muted/30 space-y-3">
            <div className="flex items-center gap-3">
              {data?.smtpConfigured ? (
                <>
                  <CheckCircle className="h-5 w-5 text-emerald-500" />
                  <div className="flex-1">
                    <p className="font-medium text-sm">{t("adminDashboard.emailSettings.smtpStatus.configured")}</p>
                    <p className="text-xs text-muted-foreground">
                      {data.smtpStatus?.host && data.smtpStatus?.port 
                        ? `${data.smtpStatus.host}:${data.smtpStatus.port}` 
                        : t("adminDashboard.emailSettings.smtpStatus.emailSendingEnabled")}
                    </p>
                  </div>
                  <Badge variant="outline" data-testid="status-smtp-configured">
                    {t("adminDashboard.emailSettings.smtpStatus.active")}
                  </Badge>
                </>
              ) : (
                <>
                  <AlertCircle className="h-5 w-5 text-amber-500" />
                  <div className="flex-1">
                    <p className="font-medium text-sm">{t("adminDashboard.emailSettings.smtpStatus.notConfigured")}</p>
                    <p className="text-xs text-muted-foreground">
                      {data?.smtpStatus?.missingFields && data.smtpStatus.missingFields.length > 0
                        ? t("adminDashboard.emailSettings.smtpStatus.missing", { fields: data.smtpStatus.missingFields.join(', ') })
                        : t("adminDashboard.emailSettings.smtpStatus.configureHint")}
                    </p>
                  </div>
                  <Badge variant="secondary" data-testid="status-smtp-not-configured">
                    {t("adminDashboard.emailSettings.smtpStatus.inactive")}
                  </Badge>
                </>
              )}
            </div>
            
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => testSmtpMutation.mutate()}
                disabled={testSmtpMutation.isPending}
                data-testid="button-test-smtp"
              >
                {testSmtpMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-2" />
                )}
                {t("adminDashboard.emailSettings.testSmtp")}
              </Button>
              {smtpTestResult && (
                <div className="flex items-center gap-2 text-sm">
                  {smtpTestResult.success ? (
                    <>
                      <CheckCircle className="h-4 w-4 text-emerald-500" />
                      <span className="text-emerald-600 dark:text-emerald-400">{t("adminDashboard.emailSettings.connectionVerified")}</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 text-red-500" />
                      <span className="text-red-600 dark:text-red-400">{smtpTestResult.error}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          <Alert>
            <Mail className="h-4 w-4" />
            <AlertDescription>
              {t("adminDashboard.emailSettings.templateHint")}
            </AlertDescription>
          </Alert>

          {groupedConfigs.map(({ category, configs }) => (
            <div key={category} className="space-y-3">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                {t(`adminDashboard.emailSettings.categories.${category}`) || category}
              </h3>
              <div className="space-y-2">
                {configs.map((config) => {
                  const setting = getSettingByEventType(config.eventType);
                  const template = getTemplateByType(config.templateType);
                  const IconComponent = config.icon;
                  const isEnabled = setting?.isEnabled ?? true;
                  
                  return (
                    <div
                      key={config.eventType}
                      className="flex items-center justify-between p-4 rounded-lg border bg-card hover-elevate transition-colors gap-4"
                      data-testid={`email-setting-${config.eventType}`}
                    >
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className="bg-primary/10 p-2 rounded-md shrink-0">
                          <IconComponent className="h-4 w-4 text-primary" />
                        </div>
                        <div className="space-y-1 min-w-0">
                          <p className="font-medium text-sm">{t(`adminDashboard.emailSettings.configs.${config.eventType}.displayName`)}</p>
                          <p className="text-xs text-muted-foreground">{t(`adminDashboard.emailSettings.configs.${config.eventType}.description`)}</p>
                          {template && (
                            <Badge variant="secondary" className="text-xs mt-1">
                              {t("adminDashboard.emailSettings.templateLabel", { name: template.name })}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEditTemplate(config.templateType)}
                          data-testid={`button-edit-template-${config.eventType}`}
                        >
                          <Edit className="h-3 w-3 mr-1" />
                          {t("adminDashboard.emailSettings.editTemplate")}
                        </Button>
                        <Switch
                          checked={isEnabled}
                          onCheckedChange={() => handleToggle(config.eventType, isEnabled)}
                          disabled={updateSettingMutation.isPending}
                          data-testid={`switch-${config.eventType}`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {groupedConfigs.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <Mail className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>{t("adminDashboard.emailSettings.empty")}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <EmailTemplateEditor
        isOpen={showTemplateEditor}
        onClose={() => setShowTemplateEditor(false)}
        template={editingTemplate as any}
        onSave={() => {}}
        templateType={editingTemplateType}
      />
    </div>
  );
}
