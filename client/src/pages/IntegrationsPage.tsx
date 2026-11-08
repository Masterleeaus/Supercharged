import { useState } from "react";
import { motion } from "framer-motion";
import { 
  Phone, Mic, Webhook, Code, Zap,
  ArrowRight, ExternalLink, Check, Calendar, FileSpreadsheet, CreditCard, RefreshCw, Loader2, CheckCircle2, AlertCircle, Cpu, Users, PhoneCall
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { SEOHead } from "@/components/landing/SEOHead";
import { Link } from "wouter";
import { SiTwilio, SiOpenai, SiZapier, SiGoogle, SiGooglecalendar, SiStripe, SiPaypal, SiWhatsapp } from "react-icons/si";
import { useBranding } from "@/components/BrandingProvider";
import { useSeoSettings } from "@/hooks/useSeoSettings";
import { useTranslation } from "react-i18next";
import { AuthStorage } from "../lib/auth-storage";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";

interface IntegrationCardProps {
  icon: React.ReactNode;
  name: string;
  description: string;
  category: string;
  delay: number;
  status?: { connected: boolean; email?: string } | null;
  isLoadingStatus?: boolean;
  requiresAuth?: boolean;
}

const IntegrationCard = ({ icon, name, description, category, delay, status, isLoadingStatus, requiresAuth }: IntegrationCardProps) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true }}
    transition={{ duration: 0.5, delay }}
    whileHover={{ y: -5 }}
    className="feature-card-border p-6 hover:shadow-lg transition-all duration-300 flex flex-col justify-between h-full bg-card"
  >
    <div>
      <div className="flex items-start justify-between mb-4">
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-900 flex items-center justify-center">
          {icon}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300">
            {category}
          </span>
          {requiresAuth && (
            <>
              {isLoadingStatus ? (
                <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
              ) : status?.connected ? (
                <Badge variant="default" className="text-[10px] bg-green-500/10 hover:bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/20 gap-1 py-0">
                  <CheckCircle2 className="w-2.5 h-2.5" /> Connected
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] text-muted-foreground border-muted-foreground/20 py-0">
                  Available
                </Badge>
              )}
            </>
          )}
        </div>
      </div>
      <h3 className="text-lg font-semibold mb-2">{name}</h3>
      <p className="text-sm text-muted-foreground mb-4">{description}</p>
    </div>
    {requiresAuth && status?.connected && status?.email && (
      <p className="text-[11px] text-muted-foreground truncate border-t pt-2 mt-auto">
        Connected as: <span className="font-mono text-indigo-600 dark:text-indigo-400">{status.email}</span>
      </p>
    )}
  </motion.div>
);

export default function IntegrationsPage() {
  const { branding } = useBranding();
  const { data: seoSettings } = useSeoSettings();
  const { t } = useTranslation();
  const [activeCategory, setActiveCategory] = useState<string>("all");
  
  const isAuthenticated = AuthStorage.isAuthenticated();

  // Fetch 3rd party integration statuses if authenticated
  const { data: googleSheetsStatus, isLoading: loadingGoogleSheets } = useQuery({
    queryKey: ["/api/integrations/google/status"],
    enabled: isAuthenticated,
    retry: false,
  });

  const { data: googleCalendarStatus, isLoading: loadingGoogleCalendar } = useQuery({
    queryKey: ["/api/google-calendar/status"],
    enabled: isAuthenticated,
    retry: false,
  });

  const integrations = [
    // Telephony
    {
      icon: <SiTwilio className="w-6 h-6 text-red-500" />,
      name: t('landing.integrationsPage.integrations.twilio.name'),
      description: t('landing.integrationsPage.integrations.twilio.description'),
      category: t('landing.integrationsPage.categories.telephony'),
      catKey: "telephony"
    },
    {
      icon: <Phone className="w-6 h-6 text-green-500" />,
      name: t('landing.integrationsPage.integrations.plivo.name'),
      description: t('landing.integrationsPage.integrations.plivo.description'),
      category: t('landing.integrationsPage.categories.telephony'),
      catKey: "telephony"
    },
    {
      icon: <PhoneCall className="w-6 h-6 text-indigo-600" />,
      name: "SIP Trunking",
      description: "Connect your custom telephony lines, SIP gateways, and private PBX networks directly to the Voice AI pool.",
      category: t('landing.integrationsPage.categories.telephony'),
      catKey: "telephony"
    },
    // AI/LLM
    {
      icon: <SiOpenai className="w-6 h-6 text-slate-900 dark:text-white" />,
      name: t('landing.integrationsPage.integrations.openai.name'),
      description: t('landing.integrationsPage.integrations.openai.description'),
      category: t('landing.integrationsPage.categories.aiLlm'),
      catKey: "aiLlm"
    },
    {
      icon: <Mic className="w-6 h-6 text-indigo-500" />,
      name: t('landing.integrationsPage.integrations.elevenlabs.name'),
      description: t('landing.integrationsPage.integrations.elevenlabs.description'),
      category: t('landing.integrationsPage.categories.voice'),
      catKey: "voice"
    },
    {
      icon: <Cpu className="w-6 h-6 text-purple-600" />,
      name: "Custom Voice Engine",
      description: "Plug in custom voice synthesis models (TTS) and voice recognition engines (STT) for specialized workflows.",
      category: t('landing.integrationsPage.categories.voice'),
      catKey: "voice"
    },
    // Productivity
    {
      icon: <FileSpreadsheet className="w-6 h-6 text-emerald-600" />,
      name: "Google Sheets",
      description: "Auto-push lead form submissions and call results directly to your spreadsheets in real-time.",
      category: "Productivity",
      catKey: "productivity",
      requiresAuth: true,
      status: googleSheetsStatus,
      isLoadingStatus: loadingGoogleSheets
    },
    {
      icon: <Calendar className="w-6 h-6 text-blue-600" />,
      name: "Google Calendar",
      description: "Let your AI voice agents book meetings, check availability, and sync events directly with calendar feeds.",
      category: "Productivity",
      catKey: "productivity",
      requiresAuth: true,
      status: googleCalendarStatus,
      isLoadingStatus: loadingGoogleCalendar
    },
    // Payments
    {
      icon: <SiStripe className="w-6 h-6 text-[#635BFF]" />,
      name: "Stripe",
      description: "Secure payment processing and automated billing integration to collect payments during calls.",
      category: "Payments",
      catKey: "payments"
    },
    {
      icon: <SiPaypal className="w-6 h-6 text-[#003087]" />,
      name: "PayPal",
      description: "Accept secure global transactions with the world's most trusted electronic payment system.",
      category: "Payments",
      catKey: "payments"
    },
    {
      icon: <CreditCard className="w-6 h-6 text-amber-500" />,
      name: "Razorpay",
      description: "Optimized payment gateway with high success rates for local and global payments.",
      category: "Payments",
      catKey: "payments"
    },
    {
      icon: <CreditCard className="w-6 h-6 text-teal-600" />,
      name: "Paystack",
      description: "Modern, secure payments interface built for startups and enterprises globally.",
      category: "Payments",
      catKey: "payments"
    },
    {
      icon: <CreditCard className="w-6 h-6 text-sky-500" />,
      name: "MercadoPago",
      description: "Fully featured transactions network and payment processing setup.",
      category: "Payments",
      catKey: "payments"
    },
    // Messaging / Communication
    {
      icon: <SiWhatsapp className="w-6 h-6 text-green-500" />,
      name: "WhatsApp (Meta)",
      description: "Send automated WhatsApp template notifications and alerts directly to callers using the Meta Cloud API.",
      category: "Messaging",
      catKey: "messaging"
    },
    {
      icon: <Users className="w-6 h-6 text-orange-600" />,
      name: "Team Management",
      description: "Add multiple team members, configure role-based access permissions, and track active team audit logs.",
      category: "Workspace",
      catKey: "workspace"
    },
    // Developer
    {
      icon: <Webhook className="w-6 h-6 text-purple-500" />,
      name: t('landing.integrationsPage.integrations.webhooks.name'),
      description: t('landing.integrationsPage.integrations.webhooks.description'),
      category: t('landing.integrationsPage.categories.developer'),
      catKey: "developer"
    },
    {
      icon: <Code className="w-6 h-6 text-blue-500" />,
      name: t('landing.integrationsPage.integrations.restApi.name'),
      description: t('landing.integrationsPage.integrations.restApi.description'),
      category: t('landing.integrationsPage.categories.developer'),
      catKey: "developer"
    }
  ];

  const filteredIntegrations = activeCategory === "all"
    ? integrations
    : integrations.filter(item => item.catKey === activeCategory || item.category.toLowerCase() === activeCategory);

  const apiFeatures = [
    t('landing.integrationsPage.api.features.createAgents'),
    t('landing.integrationsPage.api.features.launchCampaigns'),
    t('landing.integrationsPage.api.features.accessCallStatus'),
    t('landing.integrationsPage.api.features.manageContacts'),
    t('landing.integrationsPage.api.features.configureWebhooks'),
    t('landing.integrationsPage.api.features.generateAnalytics')
  ];

  const webhookEvents = [
    t('landing.integrationsPage.webhooks.events.callStarted'),
    t('landing.integrationsPage.webhooks.events.callCompleted'),
    t('landing.integrationsPage.webhooks.events.callFailed'),
    t('landing.integrationsPage.webhooks.events.campaignStarted'),
    t('landing.integrationsPage.webhooks.events.campaignCompleted'),
    t('landing.integrationsPage.webhooks.events.appointmentBooked')
  ];

  const webhookFeatures = [
    t('landing.integrationsPage.webhooks.features.hmac'),
    t('landing.integrationsPage.webhooks.features.retry'),
    t('landing.integrationsPage.webhooks.features.logs')
  ];
  
  return (
    <div className="min-h-screen bg-background" data-testid="integrations-page">
      <SEOHead
        title={t('landing.integrationsPage.seo.title')}
        description={t('landing.integrationsPage.seo.description')}
        canonicalUrl={seoSettings?.canonicalBaseUrl ? `${seoSettings.canonicalBaseUrl}/integrations` : undefined}
        ogImage={seoSettings?.defaultOgImage || undefined}
        ogSiteName={branding.app_name}
        twitterSite={seoSettings?.twitterHandle || undefined}
        twitterCreator={seoSettings?.twitterHandle || undefined}
        googleVerification={seoSettings?.googleVerification || undefined}
        bingVerification={seoSettings?.bingVerification || undefined}
        facebookAppId={seoSettings?.facebookAppId || undefined}
        structuredDataOrg={seoSettings?.structuredDataOrg}
      />

      <Navbar />

      <main className="pt-16">
        {/* Hero */}
        <section className="py-16 md:py-24 hero-gradient">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
            >
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-100 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 mb-6">
                <Zap className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300">
                  {t('landing.integrationsPage.hero.badge')}
                </span>
              </div>
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6">
                {t('landing.integrationsPage.hero.title')}
                <br />
                <span className="gradient-text-primary">{t('landing.integrationsPage.hero.titleHighlight')}</span>
              </h1>
              <p className="text-lg md:text-xl text-muted-foreground max-w-3xl mx-auto">
                {t('landing.integrationsPage.hero.subtitle')}
              </p>
            </motion.div>
          </div>
        </section>

        {/* Integration Filtering and Grid */}
        <section className="py-8 md:py-16">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-center justify-center gap-2 mb-10">
              {[
                { label: "All", value: "all" },
                { label: "Telephony", value: "telephony" },
                { label: "AI & Voice", value: "voice" },
                { label: "Productivity", value: "productivity" },
                { label: "Payments", value: "payments" },
                { label: "Developer", value: "developer" }
              ].map((category) => (
                <Button
                  key={category.value}
                  variant={activeCategory === category.value ? "default" : "outline"}
                  onClick={() => setActiveCategory(category.value)}
                  className="rounded-full px-5 py-1.5 text-xs font-medium transition-all"
                >
                  {category.label}
                </Button>
              ))}
            </div>

            {isAuthenticated && (
              <div className="mb-8 p-4 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100/50 dark:border-indigo-900/50 flex flex-col sm:flex-row items-center justify-between gap-4 max-w-3xl mx-auto">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-indigo-100 dark:bg-indigo-900 rounded-lg">
                    <RefreshCw className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-sm">Managing Your Active Integrations</h4>
                    <p className="text-xs text-muted-foreground">You are authenticated. We've loaded the active connection status for your 3rd-party services.</p>
                  </div>
                </div>
                <Link href="/app/tools">
                  <Button size="sm" className="shrink-0 gap-1.5">
                    Configure Connections <ArrowRight className="w-3.5 h-3.5" />
                  </Button>
                </Link>
              </div>
            )}

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {filteredIntegrations.map((integration, index) => (
                <IntegrationCard
                  key={integration.name}
                  {...(integration as any)}
                  delay={index * 0.05}
                />
              ))}
            </div>
          </div>
        </section>

        {/* API Overview */}
        <section className="py-16 md:py-24 section-gradient-1">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <motion.div
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
              >
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-100 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 mb-6">
                  <Code className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300">
                    {t('landing.integrationsPage.api.badge')}
                  </span>
                </div>
                
                <h2 className="text-3xl md:text-4xl font-bold mb-4">
                  {t('landing.integrationsPage.api.title')}
                </h2>
                <p className="text-muted-foreground mb-6">
                  {t('landing.integrationsPage.api.description')}
                </p>

                <ul className="space-y-3 mb-8">
                  {apiFeatures.map((feature, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <Check className="w-5 h-5 text-green-500 mt-0.5 shrink-0" />
                      <span className="text-muted-foreground">{feature}</span>
                    </li>
                  ))}
                </ul>

                <Button variant="outline" className="gap-2">
                  {t('landing.integrationsPage.api.viewDocs')}
                  <ExternalLink className="w-4 h-4" />
                </Button>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, x: 30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                className="feature-card-border p-6"
              >
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-3 h-3 rounded-full bg-red-500" />
                  <div className="w-3 h-3 rounded-full bg-yellow-500" />
                  <div className="w-3 h-3 rounded-full bg-green-500" />
                </div>
                <pre className="text-sm overflow-x-auto">
                  <code className="text-muted-foreground">
{`// Create an AI agent
const agent = await api.agents.create({
  name: "Sales Agent",
  voice: "emma",
  language: "en-US",
  systemPrompt: "You are a helpful..."
});

// Launch a campaign
const campaign = await api.campaigns.create({
  agentId: agent.id,
  contacts: contactList,
  schedule: "2024-01-15T09:00:00Z"
});`}
                  </code>
                </pre>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Webhook Events */}
        <section className="py-16 md:py-24">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <motion.div
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                className="order-2 lg:order-1"
              >
                <div className="feature-card-border p-6">
                  <h4 className="font-semibold mb-4">{t('landing.integrationsPage.webhooks.availableEvents')}</h4>
                  <ul className="space-y-3">
                    {webhookEvents.map((event, i) => (
                      <li key={i} className="flex items-start gap-3 text-sm">
                        <div className="w-2 h-2 rounded-full bg-indigo-500 mt-2 shrink-0" />
                        <code className="text-muted-foreground">{event}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, x: 30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                className="order-1 lg:order-2"
              >
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-100 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 mb-6">
                  <Webhook className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300">
                    {t('landing.integrationsPage.webhooks.badge')}
                  </span>
                </div>
                
                <h2 className="text-3xl md:text-4xl font-bold mb-4">
                  {t('landing.integrationsPage.webhooks.title')}
                </h2>
                <p className="text-muted-foreground mb-6">
                  {t('landing.integrationsPage.webhooks.description')}
                </p>

                <ul className="space-y-3">
                  {webhookFeatures.map((feature, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <Check className="w-5 h-5 text-green-500 mt-0.5 shrink-0" />
                      <span className="text-muted-foreground">{feature}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-16 md:py-24 section-gradient-2">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
            >
              <h2 className="text-3xl md:text-4xl font-bold mb-4">
                {t('landing.integrationsPage.cta.title')}
              </h2>
              <p className="text-lg text-muted-foreground mb-8">
                {t('landing.integrationsPage.cta.subtitle')}
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link href="/login">
                  <Button className="cta-button text-white font-medium border-0 h-14 px-8 text-lg">
                    {t('landing.integrationsPage.cta.startFreeTrial')}
                    <ArrowRight className="w-5 h-5 ml-2" />
                  </Button>
                </Link>
              </div>
            </motion.div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}

