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
import { motion } from "framer-motion";
import { Mic2, Calendar, Webhook, Bot } from "lucide-react";
import { useBranding } from "@/components/BrandingProvider";
import { ComponentType } from "react";
import { useTranslation } from "react-i18next";

const SiSalesforce = (props: React.ComponentProps<"svg">) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M19.043 11.233a3.526 3.526 0 0 0-1.803-.896 4.385 4.385 0 0 0-8.243-1.63 3.655 3.655 0 0 0-4.606 4.542A3.208 3.208 0 0 0 4.5 19.5h14.5a3.21 3.21 0 0 0 3.14-2.525 3.526 3.526 0 0 0-3.097-5.742z" />
  </svg>
);

const SiSlack = (props: React.ComponentProps<"svg">) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523 2.528 2.528 0 0 1-2.522-2.523 2.528 2.528 0 0 1 2.522-2.52h2.52v2.52zm1.261 0a2.528 2.528 0 0 1 2.52-2.52h5.043a2.528 2.528 0 0 1 2.522 2.52v5.042a2.528 2.528 0 0 1-2.522 2.52H8.823a2.528 2.528 0 0 1-2.52-2.52v-5.042zM8.823 5.043a2.528 2.528 0 0 1-2.52-2.52 2.528 2.528 0 0 1 2.52-2.522 2.528 2.528 0 0 1 2.522 2.522v2.52h-2.522zm0 1.261a2.528 2.528 0 0 1 2.522 2.52v5.043a2.528 2.528 0 0 1-2.522 2.522H3.78a2.528 2.528 0 0 1-2.52-2.522V8.824a2.528 2.528 0 0 1 2.52-2.52h5.043zm10.135 3.761a2.528 2.528 0 0 1 2.522-2.52 2.528 2.528 0 0 1 2.52 2.52 2.528 2.528 0 0 1-2.52 2.52h-2.522v-2.52zm-1.262 0a2.528 2.528 0 0 1-2.52 2.52h-5.043a2.528 2.528 0 0 1-2.522-2.52V3.78a2.528 2.528 0 0 1 2.522-2.52h5.043a2.528 2.528 0 0 1 2.52 2.52v5.043zm-3.76 10.134a2.528 2.528 0 0 1 2.52 2.522 2.528 2.528 0 0 1-2.52 2.52 2.528 2.528 0 0 1-2.522-2.52v-2.522h2.522zm0-1.261a2.528 2.528 0 0 1-2.522-2.52v-5.043a2.528 2.528 0 0 1 2.522-2.522h5.043a2.528 2.528 0 0 1 2.52 2.522v5.043a2.528 2.528 0 0 1-2.52 2.52h-5.043z" />
  </svg>
);

const SiTwilio = (props: React.ComponentProps<"svg">) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm-4.32 17.52c-1.5 0-2.7-1.2-2.7-2.7s1.2-2.7 2.7-2.7 2.7 1.2 2.7 2.7-1.2 2.7-2.7 2.7zm0-6c-1.5 0-2.7-1.2-2.7-2.7s1.2-2.7 2.7-2.7 2.7 1.2 2.7 2.7-1.2 2.7-2.7 2.7zm8.64 6c-1.5 0-2.7-1.2-2.7-2.7s1.2-2.7 2.7-2.7 2.7 1.2 2.7 2.7-1.2 2.7-2.7 2.7zm0-6c-1.5 0-2.7-1.2-2.7-2.7s1.2-2.7 2.7-2.7 2.7 1.2 2.7 2.7-1.2 2.7-2.7 2.7z" />
  </svg>
);

const SiStripe = (props: React.ComponentProps<"svg">) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M13.962 10.016c0-1.077-.852-1.748-2.316-1.748-2.453 0-4.938.995-4.938.995L6 5.864s2.836-1.233 5.92-1.233c4.27 0 6.643 2.113 6.643 5.56 0 5.093-6.93 6.002-6.93 8.046 0 1.222.956 1.94 2.628 1.94 2.664 0 5.626-1.282 5.626-1.282l.71 3.49s-2.822 1.341-6.19 1.341c-4.482 0-7.05-2.228-7.05-5.69 0-5.187 7.153-6.096 7.153-8.06z" />
  </svg>
);

const SiZapier = (props: React.ComponentProps<"svg">) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M19.348 10.378H12.96v-7.14L4.652 13.622h6.388v7.14l8.308-10.384z" />
  </svg>
);

const SiOpenai = (props: React.ComponentProps<"svg">) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M22.059 10.598A6.368 6.368 0 0 0 20.3 6.452a6.37 6.37 0 0 0-4.887-2.327 6.42 6.42 0 0 0-4.665 2.015 6.364 6.364 0 0 0-4.885 2.329 6.367 6.367 0 0 0-1.758 4.144 6.366 6.366 0 0 0 1.761 4.148 6.37 6.37 0 0 0 4.887 2.327 6.42 6.42 0 0 0 4.665-2.015 6.364 6.364 0 0 0 4.885-2.329 6.367 6.367 0 0 0 1.758-4.144M11.64 5.25a5.163 5.163 0 0 1 3.522 1.39l-4.72 2.723a.625.625 0 0 0-.312.541v6.236L7.132 14.46a5.132 5.132 0 0 1-1.782-3.862 5.158 5.158 0 0 1 1.63-3.824A5.159 5.159 0 0 1 11.64 5.25m-6.23 9.382a5.13 5.13 0 0 1 .15-4.253l4.72 2.722a.625.625 0 0 0 .625 0l5.4-3.118v3.402a5.132 5.132 0 0 1-1.782 3.862l-6.19 3.57a5.16 5.16 0 0 1-2.923.15m10.96 4.118a5.13 5.13 0 0 1-3.672-.136l4.72-2.723a.625.625 0 0 0 .312-.541V9.112l5.4 3.118a5.132 5.132 0 0 1 1.782 3.862 5.158 5.158 0 0 1-1.63 3.824 5.159 5.159 0 0 1-6.612.636M12.36 18.75a5.163 5.163 0 0 1-3.522-1.39l4.72-2.723c.184-.106.312-.31.312-.541V7.86l2.998 1.68a5.132 5.132 0 0 1 1.782 3.862 5.158 5.158 0 0 1-1.63 3.824A5.159 5.159 0 0 1 12.36 18.75m6.23-9.382a5.13 5.13 0 0 1-.15 4.253l-4.72-2.722a.625.625 0 0 0-.625 0l-5.4 3.118V10.61a5.132 5.132 0 0 1 1.782-3.862l6.19-3.57a5.16 5.16 0 0 1 2.923-.15M7.4 5.25a5.13 5.13 0 0 1 3.672.136L6.352 8.11a.625.625 0 0 0-.312.541v6.236l-5.4-3.118A5.132 5.132 0 0 1-1.142 7.91a5.158 5.158 0 0 1 1.63-3.824 5.159 5.159 0 0 1 6.912-.136m4.6 3.684-2.7-1.56 2.7-1.56 2.7 1.56z" />
  </svg>
);

const SiNotion = (props: React.ComponentProps<"svg">) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M4.222 3.111C4.222 2.5 4.722 2 5.333 2h13.334c.61 0 1.11.5 1.11 1.111v17.778c0 .611-.5 1.111-1.11 1.111H5.333c-.611 0-1.111-.5-1.111-1.111V3.111zm2.222 2.222v13.334h11.112V5.333H6.444z" />
  </svg>
);

const SiHubspot = (props: React.ComponentProps<"svg">) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M18.889 10.384a3.81 3.81 0 0 0-3.32-3.315v-1.74a2.766 2.766 0 1 0-2.223 0v1.74a3.81 3.81 0 0 0-3.32 3.315H8.286a2.766 2.766 0 1 0 0 2.223h1.74a3.81 3.81 0 0 0 3.32 3.32v1.74a2.766 2.766 0 1 0 2.223 0v-1.74a3.81 3.81 0 0 0 3.32-3.32h1.74a2.766 2.766 0 1 0 0-2.223h-1.74zm-5.556-2.5a1.667 1.667 0 1 1 0 3.334 1.667 1.667 0 0 1 0-3.334z" />
  </svg>
);

interface Integration {
  name: string;
  icon: ComponentType<{ className?: string }>;
  color: string;
  bgColor: string;
  position: { x: number; y: number };
  size: "sm" | "md" | "lg";
  delay: number;
}

const integrations: Integration[] = [
  {
    name: "Salesforce",
    icon: SiSalesforce,
    color: "#00A1E0",
    bgColor: "bg-white",
    position: { x: 5, y: 75 },
    size: "md",
    delay: 0,
  },
  {
    name: "Slack",
    icon: SiSlack,
    color: "#4A154B",
    bgColor: "bg-white",
    position: { x: 12, y: 55 },
    size: "sm",
    delay: 0.1,
  },
  {
    name: "Twilio",
    icon: SiTwilio,
    color: "#F22F46",
    bgColor: "bg-white",
    position: { x: 20, y: 70 },
    size: "md",
    delay: 0.2,
  },
  {
    name: "Zapier",
    icon: SiZapier,
    color: "#FF4A00",
    bgColor: "bg-white",
    position: { x: 28, y: 50 },
    size: "sm",
    delay: 0.3,
  },
  {
    name: "ElevenLabs",
    icon: Mic2,
    color: "#000000",
    bgColor: "bg-white",
    position: { x: 38, y: 65 },
    size: "md",
    delay: 0.4,
  },
  {
    name: "Notion",
    icon: SiNotion,
    color: "#000000",
    bgColor: "bg-white",
    position: { x: 48, y: 45 },
    size: "md",
    delay: 0.5,
  },
  {
    name: "OpenAI",
    icon: SiOpenai,
    color: "#10A37F",
    bgColor: "bg-white",
    position: { x: 58, y: 60 },
    size: "md",
    delay: 0.6,
  },
  {
    name: "Cal.com",
    icon: Calendar,
    color: "#292929",
    bgColor: "bg-white",
    position: { x: 75, y: 35 },
    size: "sm",
    delay: 0.8,
  },
  {
    name: "Stripe",
    icon: SiStripe,
    color: "#635BFF",
    bgColor: "bg-white",
    position: { x: 82, y: 55 },
    size: "md",
    delay: 0.9,
  },
  {
    name: "HubSpot",
    icon: SiHubspot,
    color: "#FF7A59",
    bgColor: "bg-white",
    position: { x: 92, y: 40 },
    size: "sm",
    delay: 1.0,
  },
];

const sizeClasses = {
  sm: "w-12 h-12 md:w-14 md:h-14",
  md: "w-14 h-14 md:w-16 md:h-16",
  lg: "w-20 h-20 md:w-24 md:h-24",
};

const iconSizeClasses = {
  sm: "w-5 h-5 md:w-6 md:h-6",
  md: "w-6 h-6 md:w-7 md:h-7",
  lg: "w-10 h-10 md:w-12 md:h-12",
};

interface IntegrationBubbleProps {
  integration: Integration;
}

function IntegrationBubble({ integration }: IntegrationBubbleProps) {
  const IconComponent = integration.icon;

  return (
    <motion.div
      className="absolute"
      style={{
        left: `${integration.position.x}%`,
        top: `${integration.position.y}%`,
        transform: "translate(-50%, -50%)",
      }}
      initial={{ opacity: 0, scale: 0 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true }}
      transition={{
        duration: 0.5,
        delay: integration.delay,
        type: "spring",
        stiffness: 200,
      }}
      data-testid={`integration-bubble-${integration.name.toLowerCase().replace(".", "-")}`}
    >
      <motion.div
        className={`${sizeClasses[integration.size]} ${integration.bgColor} rounded-full shadow-lg flex items-center justify-center cursor-pointer`}
        style={{
          boxShadow: `0 4px 20px ${integration.color}20`,
        }}
        animate={{
          y: [0, -8, 0],
        }}
        transition={{
          duration: 3 + integration.delay,
          repeat: Infinity,
          ease: "easeInOut",
        }}
        whileHover={{
          scale: 1.15,
          boxShadow: `0 8px 30px ${integration.color}40`,
        }}
      >
        <span style={{ color: integration.color }}>
          <IconComponent className={iconSizeClasses[integration.size]} />
        </span>
      </motion.div>
      <motion.div
        className="absolute -bottom-6 left-1/2 transform -translate-x-1/2 whitespace-nowrap text-xs font-medium text-white/80 opacity-0 group-hover:opacity-100"
        initial={{ opacity: 0 }}
        whileHover={{ opacity: 1 }}
      >
        {integration.name}
      </motion.div>
    </motion.div>
  );
}

function CentralHub() {
  const { branding } = useBranding();

  return (
    <motion.div
      className="absolute"
      style={{
        left: "68%",
        top: "55%",
        transform: "translate(-50%, -50%)",
      }}
      initial={{ opacity: 0, scale: 0 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true }}
      transition={{
        duration: 0.6,
        delay: 0.7,
        type: "spring",
        stiffness: 150,
      }}
      data-testid="integration-central-hub"
    >
      <motion.div
        className="w-24 h-24 md:w-32 md:h-32 rounded-full flex items-center justify-center relative"
        style={{
          background:
            "linear-gradient(135deg, rgba(255,200,180,0.9) 0%, rgba(255,170,140,0.95) 100%)",
          boxShadow:
            "0 0 60px rgba(255,150,100,0.4), 0 0 100px rgba(255,180,150,0.2)",
        }}
        animate={{
          scale: [1, 1.05, 1],
          boxShadow: [
            "0 0 60px rgba(255,150,100,0.4), 0 0 100px rgba(255,180,150,0.2)",
            "0 0 80px rgba(255,150,100,0.5), 0 0 120px rgba(255,180,150,0.3)",
            "0 0 60px rgba(255,150,100,0.4), 0 0 100px rgba(255,180,150,0.2)",
          ],
        }}
        transition={{
          duration: 3,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      >
        <div className="w-16 h-16 md:w-20 md:h-20 bg-white/90 rounded-full flex items-center justify-center shadow-inner overflow-hidden">
          {branding.favicon_url ? (
            <img 
              src={branding.favicon_url} 
              alt={branding.app_name}
              className="w-10 h-10 md:w-12 md:h-12 object-contain"
            />
          ) : (
            <Webhook className="w-8 h-8 md:w-10 md:h-10 text-orange-500" />
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function ConnectionPath() {
  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      viewBox="0 0 1000 400"
      preserveAspectRatio="none"
      data-testid="integration-connection-path"
    >
      <defs>
        <linearGradient id="pathGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.1)" />
          <stop offset="50%" stopColor="rgba(255,255,255,0.3)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0.1)" />
        </linearGradient>
      </defs>

      <motion.path
        d="M 0,300 Q 150,280 250,220 T 450,180 T 650,200 T 850,140 T 1000,180"
        fill="none"
        stroke="url(#pathGradient)"
        strokeWidth="2"
        initial={{ pathLength: 0, opacity: 0 }}
        whileInView={{ pathLength: 1, opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 2, ease: "easeInOut" }}
      />

      <motion.path
        d="M 0,320 Q 200,300 350,250 T 550,220 T 700,240 T 900,180 T 1000,200"
        fill="none"
        stroke="url(#pathGradient)"
        strokeWidth="1.5"
        initial={{ pathLength: 0, opacity: 0 }}
        whileInView={{ pathLength: 1, opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 2.2, delay: 0.2, ease: "easeInOut" }}
      />

      <motion.circle r="4" fill="rgba(255,255,255,0.8)">
        <animateMotion
          dur="6s"
          repeatCount="indefinite"
          path="M 0,300 Q 150,280 250,220 T 450,180 T 650,200 T 850,140 T 1000,180"
        />
      </motion.circle>

      <motion.circle r="3" fill="rgba(255,255,255,0.6)">
        <animateMotion
          dur="8s"
          repeatCount="indefinite"
          path="M 0,320 Q 200,300 350,250 T 550,220 T 700,240 T 900,180 T 1000,200"
        />
      </motion.circle>
    </svg>
  );
}

function FloatingParticles() {
  return (
    <>
      {[...Array(6)].map((_, i) => (
        <motion.div
          key={i}
          className="absolute w-2 h-2 rounded-full bg-white/20"
          style={{
            left: `${15 + i * 15}%`,
            top: `${30 + (i % 3) * 20}%`,
          }}
          animate={{
            y: [0, -20, 0],
            opacity: [0.2, 0.5, 0.2],
          }}
          transition={{
            duration: 4 + i * 0.5,
            repeat: Infinity,
            delay: i * 0.3,
            ease: "easeInOut",
          }}
        />
      ))}
    </>
  );
}

export function IntegrationsGrid() {
  const { branding } = useBranding();
  const { t } = useTranslation();

  return (
    <section
      className="relative py-12 sm:py-16 md:py-24 lg:py-32 overflow-hidden"
      style={{
        background:
          "linear-gradient(135deg, #a8d4f0 0%, #c4e0f5 25%, #e8d5c4 60%, #f5c9a8 100%)",
      }}
      data-testid="integrations-section"
    >
      <FloatingParticles />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center space-y-3 sm:space-y-4 mb-6 sm:mb-8"
        >
          <h2
            className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold text-slate-800"
            data-testid="integrations-headline"
          >
            {t('landing.integrations.title')}
          </h2>
          <p className="text-sm sm:text-base md:text-lg text-slate-600 max-w-2xl mx-auto">
            {t('landing.integrations.description', { appName: branding.app_name })}
          </p>
        </motion.div>

        <div
          className="relative h-[280px] sm:h-[320px] md:h-[350px] lg:h-[400px]"
          data-testid="integrations-grid"
        >
          <ConnectionPath />

          {integrations.map((integration) => (
            <IntegrationBubble key={integration.name} integration={integration} />
          ))}

          <CentralHub />
        </div>
      </div>

      <div
        className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none"
        style={{
          background:
            "linear-gradient(to top, rgba(255,255,255,0.1), transparent)",
        }}
      />
    </section>
  );
}

export default IntegrationsGrid;
