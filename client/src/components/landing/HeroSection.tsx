import { motion, useReducedMotion, useInView } from "framer-motion";
import { Check, ChevronDown, Phone, Headphones, MessageSquare, Calendar, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useRef, useState, useEffect } from "react";
import { Link } from "wouter";
import { AuthStorage } from "@/lib/auth-storage";
import { useTranslation } from 'react-i18next';
import { CveTestCallDialog } from "@/components/CveTestCallDialog";
import { useDemoMode } from "@/components/DemoModeBanner";
const heroCardSales = "/images/hero-card-sales.png";
const heroCardSupport = "/images/hero-card-support.png";
const heroCardLeads = "/images/hero-card-leads.png";
const heroCardAppointments = "/images/hero-card-appointments.png";

const TypingWord = ({ words, reduceMotion }: { words: string[]; reduceMotion: boolean | null }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [displayText, setDisplayText] = useState(words[0] || "");
  const [isDeleting, setIsDeleting] = useState(false);
  useEffect(() => {
    if (reduceMotion) {
      const interval = setInterval(() => {
        setCurrentIndex((prev) => (prev + 1) % words.length);
      }, 3000);
      return () => clearInterval(interval);
    }

    const currentWord = words[currentIndex];
    const typingSpeed = isDeleting ? 50 : 100;
    const pauseDuration = 2000;

    if (!isDeleting && displayText === currentWord) {
      const timeout = setTimeout(() => setIsDeleting(true), pauseDuration);
      return () => clearTimeout(timeout);
    }

    if (isDeleting && displayText === "") {
      setIsDeleting(false);
      setCurrentIndex((prev) => (prev + 1) % words.length);
      return;
    }

    const timeout = setTimeout(() => {
      if (isDeleting) {
        setDisplayText(currentWord.slice(0, displayText.length - 1));
      } else {
        setDisplayText(currentWord.slice(0, displayText.length + 1));
      }
    }, typingSpeed);

    return () => clearTimeout(timeout);
  }, [displayText, isDeleting, currentIndex, words, reduceMotion]);

  useEffect(() => {
    if (reduceMotion) {
      setDisplayText(words[currentIndex]);
    }
  }, [currentIndex, words, reduceMotion]);

  return (
    <span className="inline-block min-w-[200px] text-left">
      <span className="text-brand">
        {displayText}
      </span>
      {!reduceMotion && (
        <motion.span
          animate={{ opacity: [1, 0] }}
          transition={{ duration: 0.5, repeat: Infinity, repeatType: "reverse" }}
          className="inline-block w-[3px] h-[0.9em] bg-brand ml-1 align-middle"
        />
      )}
    </span>
  );
};

const StatsBadge = ({ value, label }: { value: string; label: string }) => (
  <div
    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-border bg-card dark:bg-card"
    data-testid={`stats-badge-${label.toLowerCase()}`}
  >
    <span className="text-lg font-bold text-foreground">{value}</span>
    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
  </div>
);

const TrustBadge = ({ text }: { text: string }) => (
  <div className="flex items-center gap-2 text-sm text-muted-foreground">
    <div className="w-5 h-5 rounded-full bg-emerald-500/15 dark:bg-emerald-500/20 flex items-center justify-center">
      <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
    </div>
    <span>{text}</span>
  </div>
);

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.2,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.6,
      ease: [0.25, 0.4, 0.25, 1],
    },
  },
};

export function HeroSection() {
  const { t } = useTranslation();
  const shouldReduceMotion = useReducedMotion();
  const isAuthenticated = AuthStorage.isAuthenticated();
  const isAdmin = AuthStorage.isAdmin();
  const sectionRef = useRef(null);
  const isInView = useInView(sectionRef, { once: true });
  const [isVideoOpen, setIsVideoOpen] = useState(false);
  const { isDemoMode } = useDemoMode();

  const rotatingWords = [
    t('landing.hero.rotatingWords.sales'),
    t('landing.hero.rotatingWords.support'),
    t('landing.hero.rotatingWords.outreach'),
    t('landing.hero.rotatingWords.appointments'),
  ];

  const useCaseCards = [
    {
      label: t('landing.usecasecard.label1', "Voice Agent for"),
      title: t('landing.usecasecard.title1', "Sales Outreach"),
      icon: Phone,
      image: heroCardSales,
    },
    {
      label: t('landing.usecasecard.label2', "Voice Agent for"),
      title: t('landing.usecasecard.title2', "Customer Support"),
      icon: Headphones,
      image: heroCardSupport,
    },
    {
      label: t('landing.usecasecard.label3', "Voice Agent for"),
      title: t('landing.usecasecard.title3', "Lead Qualification"),
      icon: MessageSquare,
      image: heroCardLeads,
    },
    {
      label: t('landing.usecasecard.label4', "Voice Agent for"),
      title: t('landing.usecasecard.title4', "Appointments"),
      icon: Calendar,
      image: heroCardAppointments,
    },
  ];

  const handleScrollDown = () => {
    window.scrollTo({
      top: window.innerHeight - 80,
      behavior: "smooth",
    });
  };

  const getDashboardLink = () => {
    if (isAuthenticated) {
      return isAdmin ? "/admin" : "/app";
    }
    return "/login";
  };

  return (
    <section
      ref={sectionRef}
      className="relative flex flex-col items-center overflow-hidden bg-background pt-32 pb-16 md:pt-40 md:pb-24"
      data-testid="hero-section"
    >
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[60%] dark:hidden"
        style={{
          background: 'linear-gradient(to bottom, transparent 0%, rgba(56,189,248,0.08) 30%, rgba(59,130,246,0.13) 55%, rgba(99,102,241,0.18) 80%, rgba(79,70,229,0.22) 100%)',
        }}
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[60%] hidden dark:block"
        style={{
          background: 'linear-gradient(to bottom, transparent 0%, rgba(20,184,166,0.06) 30%, rgba(59,130,246,0.10) 55%, rgba(99,102,241,0.14) 80%, rgba(79,70,229,0.18) 100%)',
        }}
        aria-hidden="true"
      />
      <div className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <motion.div
          variants={shouldReduceMotion ? undefined : containerVariants}
          initial={shouldReduceMotion ? { opacity: 1 } : "hidden"}
          animate={shouldReduceMotion ? { opacity: 1 } : (isInView ? "visible" : "hidden")}
          className="space-y-7"
        >
          <motion.div variants={itemVariants} className="flex justify-center">
            <span className="text-sm font-semibold text-primary tracking-widest uppercase">
              {t('landing.hero.badge')}
            </span>
          </motion.div>

          <motion.h1
            variants={itemVariants}
            className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.1] text-foreground"
            data-testid="hero-headline"
          >
            {t('landing.hero.headline')}
            <br />
            <TypingWord words={rotatingWords} reduceMotion={shouldReduceMotion} />
          </motion.h1>

          <motion.p
            variants={itemVariants}
            className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed"
            data-testid="hero-subheadline"
          >
            {t('landing.hero.subheadline')}
          </motion.p>

          <motion.div
            variants={itemVariants}
            className="flex flex-wrap justify-center gap-3 pt-2"
          >
            <StatsBadge value="5X" label={t('landing.hero.statsProductivity')} />
            <StatsBadge value="100X" label={t('landing.hero.statsScalability')} />
          </motion.div>

          <motion.div
            variants={itemVariants}
            className="flex justify-center gap-4 pt-4"
          >
            <Link href={getDashboardLink()}>
              <Button
                size="lg"
                className="rounded-full shadow-lg"
                data-testid="button-hero-get-started"
              >
                {t('landing.hero.getStarted')}
              </Button>
            </Link>
            <CveTestCallDialog
              buttonClassName="rounded-full shadow-lg h-11 px-8 text-sm"
              buttonText="Test Live Call"
            />
            {isDemoMode && (
              <Button
                size="lg"
                variant="outline"
                onClick={() => setIsVideoOpen(true)}
                className="rounded-full shadow-lg h-11 px-6 text-sm font-semibold border-2 border-slate-300 dark:border-slate-700 bg-background hover:bg-accent text-foreground flex items-center gap-2"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>Watch Demo Video</span>
              </Button>
            )}
          </motion.div>

          <motion.div
            variants={itemVariants}
            className="flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-8 pt-2"
            data-testid="hero-trust-badges"
          >
            <TrustBadge text={t('landing.hero.freeTrial')} />
            <TrustBadge text={t('landing.hero.freeCredit')} />
          </motion.div>
        </motion.div>
      </div>

      <motion.div
        initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: 30 }}
        animate={shouldReduceMotion ? { opacity: 1 } : (isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 })}
        transition={shouldReduceMotion ? undefined : { delay: 0.8, duration: 0.7 }}
        className="relative z-10 w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 mt-16 md:mt-20"
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {useCaseCards.map((card, index) => (
            <motion.div
              key={card.title}
              initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: 20 }}
              animate={shouldReduceMotion ? { opacity: 1 } : (isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 })}
              transition={shouldReduceMotion ? undefined : { delay: 1 + index * 0.1, duration: 0.5 }}
              className="relative overflow-hidden rounded-md aspect-[3/4] flex flex-col justify-end p-4"
              data-testid={`card-usecase-${card.title.toLowerCase().replace(/\s+/g, "-")}`}
            >
              <img
                src={card.image}
                alt={card.title}
                loading="lazy"
                decoding="async"
                className="absolute inset-0 w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
              <card.icon className="absolute top-4 right-4 h-8 w-8 text-white/30" />
              <div className="relative z-10">
                <p className="text-white/80 text-xs font-medium">{card.label}</p>
                <p className="text-white text-sm sm:text-base font-bold leading-tight">{card.title}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </motion.div>

      <motion.div
        initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={shouldReduceMotion ? undefined : { delay: 1.5, duration: 0.6 }}
        className="relative z-10 mt-12"
      >
        <button
          onClick={handleScrollDown}
          className="group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-full p-2"
          aria-label="Scroll down"
          data-testid="button-scroll-indicator"
        >
          <ChevronDown className={`h-6 w-6 text-muted-foreground transition-colors ${shouldReduceMotion ? '' : 'animate-bounce'}`} />
        </button>
      </motion.div>

      {isDemoMode && (
        <Dialog open={isVideoOpen} onOpenChange={setIsVideoOpen}>
          <DialogContent className="sm:max-w-[850px] p-2 bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
            <DialogHeader className="p-4 pb-2 text-left">
              <DialogTitle className="text-lg font-bold text-white flex items-center gap-2">
                <Play className="h-5 w-5 text-emerald-400 fill-emerald-400" />
                AgentLabs Live Demonstration
              </DialogTitle>
              <DialogDescription className="text-xs text-slate-400">
                Watch how AgentLabs powers AI voice agents, outbound calls, and real-time voice workflows.
              </DialogDescription>
            </DialogHeader>
            <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-black border border-slate-800">
              {isVideoOpen && (
                <iframe
                  src="https://drive.google.com/file/d/1OZRBW7QfboGvH5iSMMIozBKmPEnELUCW/preview"
                  className="w-full h-full border-0"
                  allow="autoplay; encrypted-media; picture-in-picture"
                  allowFullScreen
                  title="AgentLabs Demo Video"
                />
              )}
            </div>
            <div className="p-3 pt-2 text-right">
              <a
                href="https://drive.google.com/file/d/1OZRBW7QfboGvH5iSMMIozBKmPEnELUCW/view?usp=sharing"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-brand hover:underline inline-flex items-center gap-1 font-medium"
              >
                Open in Google Drive &rarr;
              </a>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

export default HeroSection;
