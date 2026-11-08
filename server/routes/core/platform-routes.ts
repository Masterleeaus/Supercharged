import type { Express, RequestHandler } from "express";
import { createAgentRoutes } from "../../routes/agent-routes";
import { createCampaignRoutes } from "../../routes/campaign-routes";
import { createPhoneRoutes } from "../../routes/phone-routes";
import { createUserAddressRoutes } from "../../routes/user-address-routes";
import { createAnalyticsRoutes } from "../../routes/analytics-routes";
import { createNotificationRoutes } from "../../routes/notification-routes";
import { createTitanFieldBridgeRouter } from "../../integrations/titan-field/route";
import { createTitanLocalLinkRouter } from "../../integrations/titan-field/local-link-route";
import { createUserWebhookRoutes } from "../../routes/user-webhook-routes";
import { createTemplateRoutes } from "../../routes/template-routes";
import { createUserSipGatewaysRoutes } from "../../routes/user-sip-gateways.routes";
import { createSubscriptionRoutes } from "../../routes/subscription-routes";
import { requireCompanyScope } from "../../middleware/company-scope";
import type { RouteContext } from "./shared";

export function registerPlatformRoutes(app: Express, deps: { routeContext: RouteContext }): void {
  const { routeContext } = deps;

  // Register agent routes (agents CRUD, knowledge base, versions, voices)
  const agentRoutes = createAgentRoutes(routeContext);
  app.use(agentRoutes);

  // Register campaign routes (campaigns CRUD, contacts, execution)
  const campaignRoutes = createCampaignRoutes(routeContext);
  app.use(campaignRoutes);

  // Register phone number routes (phone numbers CRUD, Twilio integration)
  const phoneRoutes = createPhoneRoutes(routeContext);
  app.use(phoneRoutes);

  // Register user address routes (for phone number regulatory compliance)
  const userAddressRoutes = createUserAddressRoutes(routeContext);
  app.use(userAddressRoutes);

  // Register analytics routes (dashboard, analytics, calls)
  const analyticsRoutes = createAnalyticsRoutes(routeContext);
  app.use(analyticsRoutes);

  // Register notification routes
  const notificationRoutes = createNotificationRoutes(routeContext);
  app.use(notificationRoutes);

  // TITAN: signed simulation-only Field communication intent bridge.
  // Deliberately unconfigured: the separate database integration owner must
  // supply company mapping, consent verification and an atomic event ledger.
  // No provider sending is performed; route returns 503 unless enabled.
  app.use(createTitanFieldBridgeRouter());
  // Read-only signed same-host Field/Desk capability handshake.
  app.use(createTitanLocalLinkRouter());

  // Register user webhook routes (subscription management)
  const userWebhookRoutes = createUserWebhookRoutes(routeContext, { requireCompanyScope: requireCompanyScope() as unknown as import('express').RequestHandler });
  app.use(userWebhookRoutes);

  // Register user SIP gateway routes (per-user SIP management from /app/phone-numbers)
  const userSipGatewaysRoutes = createUserSipGatewaysRoutes();
  app.use(userSipGatewaysRoutes);

  // Register template routes (prompt templates)
  const templateRoutes = createTemplateRoutes(routeContext);
  app.use(templateRoutes);

  // Register subscription routes (plans, credits, billing)
  const subscriptionRoutes = createSubscriptionRoutes(routeContext);
  app.use(subscriptionRoutes);
}
