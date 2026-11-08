/**
 * ============================================================
 * LandingPage - awaz.ai Inspired Design
 * Main landing page with all sections
 * ============================================================
 */
import { SEOHead } from "@/components/landing/SEOHead";
import { Navbar } from "@/components/landing/Navbar";
import { HeroSection } from "@/components/landing/HeroSection";
import { FeatureSection } from "@/components/landing/FeatureSection";
import { ActionCardsSection } from "@/components/landing/ActionCardsSection";
import { TechnologySection } from "@/components/landing/TechnologySection";
import { UseCasesSection } from "@/components/landing/UseCasesSection";
import { FeaturesShowcase } from "@/components/landing/FeaturesShowcase";
import { TestimonialsSection } from "@/components/landing/TestimonialsSection";
import { IntegrationsGrid } from "@/components/landing/IntegrationsGrid";
import { PricingSection } from "@/components/landing/PricingSection";
import { ContactSection } from "@/components/landing/ContactSection";
import { CTASection } from "@/components/landing/CTASection";
import { Footer } from "@/components/landing/Footer";
import { useBranding } from "@/components/BrandingProvider";
import { useSeoSettings } from "@/hooks/useSeoSettings";
import { CveTestCallDialog } from "@/components/CveTestCallDialog";
import { useDemoMode } from "@/components/DemoModeBanner";

export default function LandingPage() {
  const { branding } = useBranding();
  const { data: seoSettings } = useSeoSettings();
  const { isDemoMode } = useDemoMode();

  const defaultKeywords = [
    "AI voice agents",
    "automated calling",
    "lead qualification",
    "AI phone agents",
    "call automation",
    "voice AI",
    "outbound calling",
    "customer service AI",
    "ElevenLabs",
    "Twilio integration"
  ];

  const seoTitle = seoSettings?.defaultTitle || `${branding.app_name || "Supercharged"} | AI Communications and Business Operations`;
  const seoDescription = seoSettings?.defaultDescription || branding.app_tagline || "Manage customer communications and business operations with connected AI-powered tools.";
  const seoKeywords = (seoSettings?.defaultKeywords && seoSettings.defaultKeywords.length > 0) 
    ? seoSettings.defaultKeywords 
    : defaultKeywords;
  const seoOgImage = seoSettings?.defaultOgImage || undefined;
  const seoCanonicalUrl = seoSettings?.canonicalBaseUrl || undefined;

  return (
    <div className="min-h-screen bg-background" data-testid="landing-page">
      <SEOHead
        title={seoTitle}
        description={seoDescription}
        canonicalUrl={seoCanonicalUrl}
        ogImage={seoOgImage}
        ogSiteName={branding.app_name}
        keywords={seoKeywords}
        twitterSite={seoSettings?.twitterHandle || undefined}
        twitterCreator={seoSettings?.twitterHandle || undefined}
        googleVerification={seoSettings?.googleVerification || undefined}
        bingVerification={seoSettings?.bingVerification || undefined}
        facebookAppId={seoSettings?.facebookAppId || undefined}
        structuredDataOrg={seoSettings?.structuredDataOrg}
        structuredDataFaq={seoSettings?.structuredDataFaq}
        structuredDataProduct={seoSettings?.structuredDataProduct}
      />

      <Navbar />

      <main>
        <HeroSection />

        {isDemoMode && (
          <section id="demo" className="relative py-20 overflow-hidden bg-slate-950 text-white rounded-3xl max-w-6xl mx-auto my-12 px-6 sm:px-12 border border-white/5">
            <div className="absolute inset-0 bg-gradient-to-br from-brand/20 via-indigo-950/20 to-purple-950/20 opacity-50 pointer-events-none" />
            <div className="relative z-10 text-center max-w-2xl mx-auto space-y-6">
              <span className="text-xs font-semibold text-brand tracking-widest uppercase">Live Interactive Demo</span>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
                Experience the Future of Voice AI Today
              </h2>
              <p className="text-base text-slate-400">
                Receive a live outbound call directly to your phone. Talk with our Custom Voice Engine in real-time, experiencing ultra-low latency responses, natural tone, and intelligent flow.
              </p>
              <div className="pt-4 flex flex-wrap justify-center items-center gap-3">
                <CveTestCallDialog
                  buttonVariant="default"
                  buttonClassName="bg-brand text-brand-foreground hover:bg-brand/90 font-semibold px-8 py-5 h-12 rounded-full text-sm shadow-xl hover:scale-105 transition-all"
                  buttonText="Test Live Call Now"
                  iconClassName="h-4 w-4 mr-2"
                />
                <a
                  href="https://drive.google.com/file/d/1OZRBW7QfboGvH5iSMMIozBKmPEnELUCW/view?usp=sharing"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/20 text-white font-semibold px-6 py-3.5 h-12 rounded-full text-sm backdrop-blur-sm border border-white/10 transition-all hover:scale-105"
                >
                  <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  <span>Watch Demo Video</span>
                </a>
              </div>
            </div>
          </section>
        )}

        <section id="features">
          <FeatureSection />
        </section>

        <section id="automation">
          <ActionCardsSection />
        </section>

        <section id="technology">
          <TechnologySection />
        </section>

        <section id="highlights">
          <FeaturesShowcase />
        </section>

        <section id="use-cases">
          <UseCasesSection />
        </section>

        <section id="testimonials">
          <TestimonialsSection />
        </section>

        <section id="integrations">
          <IntegrationsGrid />
        </section>

        <section id="pricing">
          <PricingSection />
        </section>

        <section id="contact">
          <ContactSection />
        </section>

        <CTASection />
      </main>

      <Footer />
    </div>
  );
}
