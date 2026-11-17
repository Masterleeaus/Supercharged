'use strict';
/**
 * ============================================================
 * © 2025 Titan Zero Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 * Copyright (c) Titan Zero.
 * ============================================================
 */
import express, { Request, Router } from 'express';
import Stripe from 'stripe';
import { storage } from '../storage';
import { webhookRateLimiter } from '../middleware/rateLimiter';
import { NotificationService } from '../services/notification-service';
import { getStripeClient, getStripeCurrency } from '../services/stripe-service';
import { queueFailedWebhook } from '../services/webhook-retry-service';
import { emailService } from '../services/email-service';
import { generateInvoiceForTransaction } from '../services/invoice-service';
import { applyRefund } from '../services/credit-service';
import { createReplayGuard } from '../middleware/webhook-replay';
import { logger } from '../utils/logger';
import stripeCheckoutRouter from './stripe-checkout-routes';

const router: Router = express.Router();

// Replay protection for Stripe deliveries. Checked only after constructEvent
// has verified the signature. Per-process, in-memory state.
const stripeReplayGuard = createReplayGuard({
  now: () => Date.now(),
  windowMs: 5 * 60 * 1000,
  maxEntries: 10000,
  // Fail closed at capacity: refuse the new event rather than evict a remembered one.
  onFull: 'refuse',
});

// Checkout, plan-change and cancel routes are in stripe-checkout-routes.ts
router.use(stripeCheckoutRouter);

// Stripe Webhook Handler
router.post('/webhook', webhookRateLimiter, async (req, res) => {
  const stripe = await getStripeClient();
  if (!stripe) {
    return res.status(400).send('Stripe is not configured');
  }
  
  const rawReq = req as Request & { rawBody?: Buffer };
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig) {
    return res.status(400).send('No signature provided');
  }

  if (!webhookSecret) {
    logger.error('[Stripe Webhook] STRIPE_WEBHOOK_SECRET not configured; refusing webhook');
    return res.status(403).send('Stripe webhook secret not configured');
  }

  let event: Stripe.Event;

  try {
    // Use rawBody saved by express.json verify callback
    const rawBody = rawReq.rawBody || Buffer.from(JSON.stringify(req.body));
    event = stripe.webhooks.constructEvent(rawBody, sig as string, webhookSecret);
  } catch (err: any) {
    logger.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Use the signature's own timestamp (already checked by constructEvent), not
  // event.created: Stripe retries old events with a fresh signature time.
  const signedAtSeconds = Number((sig as string).match(/(?:^|,)\s*t=(\d+)/)?.[1]);
  const replay = stripeReplayGuard.check({
    provider: 'stripe',
    eventId: event.id,
    timestampMs: Number.isFinite(signedAtSeconds) ? signedAtSeconds * 1000 : null,
  });
  if (!replay.accepted) {
    logger.warn(`[Stripe Webhook] Rejected ${event.id}: ${replay.reason}`);
    if (replay.reason === 'capacity') {
      // Guard is full: ask Stripe to retry later. The body is generic.
      return res.status(503).json({ error: 'Webhook temporarily unavailable' });
    }
    return res.status(409).json({ error: 'Duplicate or stale webhook event', reason: replay.reason });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const metadata = session.metadata;
        
        if (!metadata || !metadata.userId) {
          logger.error('No userId in session metadata');
          break;
        }

        if (metadata.type === 'subscription') {
          // Handle subscription purchase - atomic upsert for idempotency
          const subscriptionId = session.subscription as string;
          const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);
          
          // Use upsert to prevent race conditions - unique constraint on stripeSubscriptionId
          const subscriptionData = {
            userId: metadata.userId,
            planId: metadata.planId!,
            status: 'active',
            currentPeriodStart: new Date((stripeSubscription as any).current_period_start * 1000),
            currentPeriodEnd: new Date((stripeSubscription as any).current_period_end * 1000),
            stripeSubscriptionId: subscriptionId,
            cancelAtPeriodEnd: false,
            billingPeriod: metadata.billingPeriod || 'monthly',
          };
          
          // Try to create, if it exists (ON CONFLICT), just skip
          let userSubId: string | undefined;
          try {
            const newSub = await storage.createUserSubscription(subscriptionData);
            userSubId = newSub.id;
          } catch (error: any) {
            // If unique constraint violation, subscription already exists - skip
            if (!error.message?.includes('unique') && !error.message?.includes('duplicate')) {
              throw error;
            }
            logger.warn(`Subscription ${subscriptionId} already exists, skipping creation`);
            const existingSub = await storage.getUserSubscription(metadata.userId);
            userSubId = existingSub?.id;
          }

          // Update user's plan type (always update to ensure consistency)
          const plan = await storage.getPlan(metadata.planId!);
          if (plan) {
            await storage.updateUser(metadata.userId, {
              planType: plan.name,
              planExpiresAt: new Date((stripeSubscription as any).current_period_end * 1000),
            });

            // Send membership upgrade notification
            await NotificationService.notifyMembershipUpgraded(metadata.userId, plan.name);

            // Log payment transaction
            const currencyConfig = await getStripeCurrency();
            const amount = (session.amount_total || 0) / 100;
            try {
              const newTransaction = await storage.createPaymentTransaction({
                userId: metadata.userId,
                type: 'subscription',
                gateway: 'stripe',
                gatewayTransactionId: session.payment_intent as string || session.id,
                gatewaySubscriptionId: subscriptionId,
                amount: amount.toFixed(2),
                currency: currencyConfig.currency.toUpperCase(),
                planId: plan.id,
                subscriptionId: userSubId,
                description: `${plan.displayName} Subscription`,
                billingPeriod: metadata.billingPeriod || 'monthly',
                status: 'completed',
                completedAt: new Date(),
              });
              logger.info(`✅ [Stripe] Logged subscription transaction for user ${metadata.userId}`);
              
              // Generate invoice and send purchase confirmation email
              try {
                await generateInvoiceForTransaction(newTransaction.id);
                await emailService.sendPurchaseConfirmation(newTransaction.id);
                logger.info(`✅ [Stripe] Purchase confirmation email sent for transaction ${newTransaction.id}`);
              } catch (emailError: any) {
                logger.error(`❌ [Stripe] Failed to send purchase confirmation email:`);
              }
            } catch (txError: any) {
              logger.error('Failed to log payment transaction:', txError);
            }
          }
        } else if (metadata.type === 'credits') {
          // Handle credit purchase - fully atomic transaction
          const credits = parseInt(metadata.credits || '0', 10);
          const paymentIntentId = session.payment_intent as string;
          
          if (paymentIntentId) {
            // Atomic: creates transaction + adds credits in single DB transaction
            // Unique constraint on stripePaymentId prevents duplicates
            try {
              await storage.addCreditsAtomic(
                metadata.userId,
                credits,
                `Purchased ${credits} credits`,
                paymentIntentId
              );
              import('../services/sip-credit-guard').then(({ reconnectAfterRecharge }) => reconnectAfterRecharge(metadata.userId)).catch(() => {});

              // Log payment transaction for credits
              const pkg = await storage.getCreditPackage(metadata.packageId!);
              if (pkg) {
                const currencyConfig = await getStripeCurrency();
                const amount = (session.amount_total || 0) / 100;
                try {
                  const creditTransaction = await storage.createPaymentTransaction({
                    userId: metadata.userId,
                    type: 'credits',
                    gateway: 'stripe',
                    gatewayTransactionId: paymentIntentId,
                    amount: amount.toFixed(2),
                    currency: currencyConfig.currency.toUpperCase(),
                    creditPackageId: pkg.id,
                    description: `${pkg.name} - ${credits} Credits`,
                    creditsAwarded: credits,
                    status: 'completed',
                    completedAt: new Date(),
                  });
                  logger.info(`✅ [Stripe] Logged credits transaction for user ${metadata.userId}`);
                  
                  // Generate invoice and send purchase confirmation email
                  try {
                    await generateInvoiceForTransaction(creditTransaction.id);
                    await emailService.sendPurchaseConfirmation(creditTransaction.id);
                    logger.info(`✅ [Stripe] Purchase confirmation email sent for credits transaction ${creditTransaction.id}`);
                  } catch (emailError: any) {
                    logger.error(`❌ [Stripe] Failed to send credits purchase confirmation email:`);
                  }
                } catch (txError: any) {
                  logger.error('Failed to log payment transaction:', txError);
                }
              }
            } catch (error: any) {
              // If unique constraint violation, payment already processed - skip
              if (!error.message?.includes('unique') && !error.message?.includes('duplicate')) {
                throw error;
              }
              logger.warn(`Payment ${paymentIntentId} already processed, skipping credit addition`);
            }
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.userId;
        
        if (userId) {
          const userSub = await storage.getUserSubscription(userId);
          if (userSub) {
            const newPeriodEnd = new Date((subscription as any).current_period_end * 1000);
            
            // Map Stripe statuses correctly for membership access
            let mappedStatus = 'active';
            if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
              mappedStatus = 'cancelled';
            } else if (subscription.status === 'incomplete_expired') {
              mappedStatus = 'expired';
            } else if (subscription.status === 'incomplete') {
              // incomplete means payment setup not done - don't grant access yet
              mappedStatus = 'cancelled';
            }
            // Only 'trialing', 'active', 'past_due' -> treated as 'active' and grant access
            
            // Update subscription record
            await storage.updateUserSubscription(userSub.id, {
              status: mappedStatus,
              currentPeriodStart: new Date((subscription as any).current_period_start * 1000),
              currentPeriodEnd: newPeriodEnd,
              cancelAtPeriodEnd: (subscription as any).cancel_at_period_end,
            });

            // CRITICAL: Update user's planType and planExpiresAt to reflect renewal (only if subscription is active/trialing)
            if (mappedStatus === 'active') {
              // Get the plan name from the subscription to ensure proper planType sync
              const plan = userSub.planId ? await storage.getPlan(userSub.planId) : null;
              const planName = plan?.name || 'pro';
              
              await storage.updateUser(userId, {
                planType: planName,
                planExpiresAt: newPeriodEnd,
              });
            }
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.userId;
        
        if (userId) {
          const userSub = await storage.getUserSubscription(userId);
          if (userSub) {
            await storage.updateUserSubscription(userSub.id, {
              status: 'expired',
            });

            // Revert user to free plan
            await storage.updateUser(userId, {
              planType: 'free',
              planExpiresAt: null,
            });

            // Downgrade logic: Update all agents using Pro LLM models to free tier model
            try {
              const { db } = await import('../db');
              const { agents, llmModels } = await import('@shared/schema');
              const { eq, and, inArray } = await import('drizzle-orm');
              
              // Get all user's agents
              const userAgents = await storage.getUserAgents(userId);
              
              // Get all Pro tier models
              const proModels = await db
                .select()
                .from(llmModels)
                .where(eq(llmModels.tier, 'pro'));
              
              const proModelIds = proModels.map(m => m.modelId);
              
              // Filter agents that are using Pro models
              const agentsToUpdate = userAgents.filter(agent => {
                const currentModel = (agent.config as any)?.model || agent.llmModel;
                return currentModel && proModelIds.includes(currentModel);
              });
              
              if (agentsToUpdate.length > 0) {
                // Dynamically fetch the first active free-tier model as fallback
                const activeFreeModels = await db
                  .select()
                  .from(llmModels)
                  .where(and(
                    eq(llmModels.tier, 'free'),
                    eq(llmModels.isActive, true)
                  ))
                  .orderBy(llmModels.sortOrder, llmModels.name)
                  .limit(1);
                
                if (activeFreeModels.length === 0) {
                  logger.error(`CRITICAL: No active free-tier LLM models available for user ${userId} downgrade. Cannot update ${agentsToUpdate.length} agent(s).`);
                  // Send notification to admins about this critical issue
                  await NotificationService.notifyAdmins(
                    'No Active Free LLM Models',
                    `User ${userId} downgraded but no active free-tier LLM models are available to migrate ${agentsToUpdate.length} agent(s). Please activate at least one free-tier model.`,
                    'critical'
                  );
                } else {
                  const defaultFreeModel = activeFreeModels[0].modelId;
                  
                  // Update each agent to use the default free model
                  for (const agent of agentsToUpdate) {
                    // Update agent config to use default free model
                    const updatedConfig = {
                      ...(typeof agent.config === 'object' ? agent.config : {}),
                      model: defaultFreeModel
                    } as any;
                    
                    await db
                      .update(agents)
                      .set({
                        config: updatedConfig,
                        llmModel: defaultFreeModel,
                        updatedAt: new Date(),
                      })
                      .where(eq(agents.id, agent.id));
                    
                    logger.info(`Updated agent ${agent.id} from Pro model to ${defaultFreeModel} (${activeFreeModels[0].name}) due to plan downgrade`);
                  }
                  
                  logger.info(`Successfully downgraded ${agentsToUpdate.length} agent(s) to free tier LLM model ${defaultFreeModel} for user ${userId}`);
                }
              }
            } catch (error) {
              logger.error('Error updating agents on plan downgrade:', error);
              // Don't throw - subscription cancellation should still complete
            }

            // Send subscription cancellation notification
            await NotificationService.notifyMembershipCancelled(userId);
          }
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        // Access subscription ID safely - may be string, object, or null
        const invoiceData = invoice as any;
        const subscriptionId = typeof invoiceData.subscription === 'string' 
          ? invoiceData.subscription 
          : invoiceData.subscription?.id;
        
        // Handle successful subscription renewal
        if (subscriptionId) {
          const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);
          const userId = stripeSubscription.metadata?.userId;
          
          if (userId) {
            const userSub = await storage.getUserSubscription(userId);
            if (userSub) {
              const newPeriodEnd = new Date((stripeSubscription as any).current_period_end * 1000);
              
              // Update subscription period
              await storage.updateUserSubscription(userSub.id, {
                status: 'active',
                currentPeriodStart: new Date((stripeSubscription as any).current_period_start * 1000),
                currentPeriodEnd: newPeriodEnd,
              });

              // CRITICAL: Update user's planExpiresAt on renewal
              await storage.updateUser(userId, {
                planExpiresAt: newPeriodEnd,
              });
              
              logger.info(`✅ Invoice payment succeeded for user ${userId}, extended until ${newPeriodEnd}`);

              // Log payment transaction for subscription renewal
              const plan = userSub.planId ? await storage.getPlan(userSub.planId) : null;
              if (plan) {
                const currencyConfig = await getStripeCurrency();
                const amount = (invoice.amount_paid || 0) / 100;
                try {
                  const renewalTransaction = await storage.createPaymentTransaction({
                    userId,
                    type: 'subscription',
                    gateway: 'stripe',
                    gatewayTransactionId: (invoice as any).payment_intent as string || invoice.id,
                    gatewaySubscriptionId: subscriptionId,
                    amount: amount.toFixed(2),
                    currency: currencyConfig.currency.toUpperCase(),
                    planId: plan.id,
                    subscriptionId: userSub.id,
                    description: `${plan.displayName} Subscription Renewal`,
                    billingPeriod: userSub.billingPeriod || 'monthly',
                    status: 'completed',
                    completedAt: new Date(),
                  });
                  logger.info(`✅ [Stripe] Logged renewal transaction for user ${userId}`);
                  
                  // Generate invoice and send purchase confirmation email for renewal
                  try {
                    await generateInvoiceForTransaction(renewalTransaction.id);
                    await emailService.sendPurchaseConfirmation(renewalTransaction.id);
                    logger.info(`✅ [Stripe] Renewal confirmation email sent for transaction ${renewalTransaction.id}`);
                  } catch (emailError: any) {
                    logger.error(`❌ [Stripe] Failed to send renewal confirmation email:`);
                  }
                } catch (txError: any) {
                  logger.error('Failed to log payment transaction:', txError);
                }
              }
            }
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const invoiceData = invoice as any;
        const subscriptionId = typeof invoiceData.subscription === 'string' 
          ? invoiceData.subscription 
          : invoiceData.subscription?.id;
        
        logger.error(`❌ Invoice payment failed: ${invoice.id}`);
        
        // Handle failed subscription payment - mark as past_due and notify user
        if (subscriptionId) {
          try {
            const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);
            const userId = stripeSubscription.metadata?.userId;
            
            if (userId) {
              const userSub = await storage.getUserSubscription(userId);
              if (userSub) {
                // Update subscription status to past_due
                await storage.updateUserSubscription(userSub.id, {
                  status: 'past_due',
                });
                
                // Notify user about payment failure
                await NotificationService.notifyPaymentFailed(userId);
                
                // Send payment failed email
                try {
                  const failedAmount = ((invoice.amount_due || 0) / 100).toFixed(2);
                  await emailService.sendPaymentFailed(userId, failedAmount, 'Subscription renewal payment failed');
                  logger.info(`✅ [Stripe] Payment failed email sent to user ${userId}`);
                } catch (emailError: any) {
                  logger.error(`❌ [Stripe] Failed to send payment failed email:`);
                }
                
                logger.warn(`⚠️ User ${userId} subscription marked as past_due due to payment failure`);
              }
            }
          } catch (error) {
            logger.error('Error handling payment failure:', error);
          }
        }
        break;
      }

      case 'charge.dispute.created': {
        // Handle chargeback/dispute - suspend user account
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
        
        logger.warn(`🚨 [Stripe] Chargeback/Dispute created: ${dispute.id} for charge ${chargeId}`);
        
        if (chargeId) {
          try {
            // Find the original transaction
            const transaction = await storage.getPaymentTransactionByGatewayId('stripe', chargeId);
            
            if (transaction) {
              const userId = transaction.userId;
              
              // Reverse credits if it was a credit purchase using centralized service
              let creditsReversed = 0;
              if (transaction.type === 'credits' && transaction.creditsAwarded) {
                const refundResult = await applyRefund({
                  userId,
                  creditsToReverse: transaction.creditsAwarded,
                  gateway: 'stripe',
                  gatewayRefundId: dispute.id,
                  transactionId: transaction.id,
                  reason: `Chargeback dispute: ${dispute.reason || 'unknown'}`,
                });
                
                if (refundResult.success && !refundResult.alreadyProcessed) {
                  creditsReversed = refundResult.creditsReversed;
                  logger.info(`🔄 [Stripe] Reversed ${creditsReversed} credits for user ${userId}. Transaction logged.`);
                }
              }
              
              // Create refund record
              await storage.createRefund({
                transactionId: transaction.id,
                userId,
                amount: transaction.amount,
                currency: transaction.currency,
                gateway: 'stripe',
                gatewayRefundId: dispute.id,
                reason: 'chargeback',
                initiatedBy: 'gateway',
                status: 'completed',
                creditsReversed: creditsReversed > 0 ? creditsReversed : undefined,
                metadata: {
                  userSuspended: true,
                  disputeReason: dispute.reason || 'unknown',
                  disputeStatus: dispute.status,
                  disputeAmount: dispute.amount,
                },
              });
              
              // Update transaction status
              await storage.updatePaymentTransaction(transaction.id, {
                status: 'refunded',
              });
              
              // SUSPEND user account
              await storage.updateUser(userId, {
                isActive: false,
              });
              
              // Send account suspended email
              try {
                await emailService.sendAccountSuspended(userId, `Chargeback dispute: ${dispute.reason || 'Unknown reason'}`);
                logger.info(`✅ [Stripe] Account suspended email sent to user ${userId}`);
              } catch (emailError: any) {
                logger.error(`❌ [Stripe] Failed to send account suspended email:`);
              }
              
              logger.warn(`⛔ [Stripe] User ${userId} suspended due to chargeback. Dispute ID: ${dispute.id}, Reason: ${dispute.reason}`);
            } else {
              logger.warn(`⚠️ [Stripe] No transaction found for charge ${chargeId}`);
            }
          } catch (error: any) {
            logger.error('Error processing chargeback:', error);
          }
        }
        break;
      }

      case 'charge.refunded': {
        // Handle external refunds (not initiated via our admin API)
        const charge = event.data.object as Stripe.Charge;
        
        logger.info(`🔄 [Stripe] Charge refunded event: ${charge.id}`);
        
        // Only process if fully refunded externally
        if (charge.refunded) {
          try {
            // Find the original transaction
            const transaction = await storage.getPaymentTransactionByGatewayId('stripe', charge.id);
            
            // Check if we already have a refund for this transaction (to avoid duplicates)
            if (transaction) {
              const existingRefunds = await storage.getTransactionRefunds(transaction.id);
              if (existingRefunds.length > 0) {
                logger.warn(`ℹ️ [Stripe] Refund already exists for charge ${charge.id}, skipping`);
                break;
              }
              
              const userId = transaction.userId;
              
              // Reverse credits if it was a credit purchase using centralized service
              let creditsReversed = 0;
              if (transaction.type === 'credits' && transaction.creditsAwarded) {
                const refundId = charge.refunds?.data?.[0]?.id || `stripe_refund_${charge.id}`;
                const refundResult = await applyRefund({
                  userId,
                  creditsToReverse: transaction.creditsAwarded,
                  gateway: 'stripe',
                  gatewayRefundId: refundId,
                  transactionId: transaction.id,
                  reason: charge.refunds?.data?.[0]?.reason || 'External refund via Stripe dashboard',
                });
                
                if (refundResult.success && !refundResult.alreadyProcessed) {
                  creditsReversed = refundResult.creditsReversed;
                  logger.info(`🔄 [Stripe] Reversed ${creditsReversed} credits for user ${userId}. Transaction logged.`);
                }
              }
              
              // Get refund ID from the charge object
              const refundId = charge.refunds?.data?.[0]?.id || `stripe_refund_${charge.id}`;
              
              // Create refund record
              await storage.createRefund({
                transactionId: transaction.id,
                userId,
                amount: transaction.amount,
                currency: transaction.currency,
                gateway: 'stripe',
                gatewayRefundId: refundId,
                reason: 'gateway_refund',
                initiatedBy: 'gateway',
                status: 'completed',
                creditsReversed: creditsReversed > 0 ? creditsReversed : undefined,
                metadata: {
                  userSuspended: false,
                  refundReason: charge.refunds?.data?.[0]?.reason || 'external_refund',
                },
              });
              
              // Update transaction status
              await storage.updatePaymentTransaction(transaction.id, {
                status: 'refunded',
              });
              
              logger.info(`✅ [Stripe] External refund processed for user ${userId}. Charge: ${charge.id}`);
            }
          } catch (error: any) {
            logger.error('Error processing external refund:', error);
          }
        }
        break;
      }

      default:
        logger.warn(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error: any) {
    logger.error('Webhook processing error:', error);

    // Processing failed, so let Stripe's retry of this event through the replay guard.
    stripeReplayGuard.forget({ provider: 'stripe', eventId: event.id });

    await queueFailedWebhook(
      'stripe',
      event.type,
      event.id,
      event.data.object,
      error.message || 'Unknown error'
    );
    
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
