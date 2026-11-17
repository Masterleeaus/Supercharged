'use strict';
/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 * Copyright (c) Titan Zero.
 * ============================================================
 */
import express, { Request, Response, Router } from 'express';
import { storage } from '../storage';
import { webhookRateLimiter } from '../middleware/rateLimiter';
import { NotificationService } from '../services/notification-service';
import { verifyWebhookSignature } from '../services/razorpay-service';
import { queueFailedWebhook } from '../services/webhook-retry-service';
import { emailService } from '../services/email-service';
import { generateInvoiceForTransaction } from '../services/invoice-service';
import { applyRefund } from '../services/credit-service';
import { logger } from '../utils/logger';
import razorpayCheckoutRouter from './razorpay-checkout-routes';

const router: Router = express.Router();

// Config, subscription, order and cancel routes are in razorpay-checkout-routes.ts
router.use(razorpayCheckoutRouter);

router.post('/webhook', webhookRateLimiter, async (req: Request, res: Response) => {
  const rawReq = req as Request & { rawBody?: Buffer };
  const signature = req.headers['x-razorpay-signature'] as string;

  try {
    const rawBody = rawReq.rawBody || Buffer.from(JSON.stringify(req.body));
    const isValid = await verifyWebhookSignature(rawBody.toString(), signature || '');

    if (!isValid) {
      logger.error('Razorpay webhook signature verification failed');
      return res.status(400).send('Invalid signature');
    }

    const event = req.body;
    const eventType = event.event;
    const payload = event.payload;

    logger.info(`📥 [Razorpay Webhook] Received event: ${eventType}`);

    switch (eventType) {
      case 'subscription.authenticated': {
        logger.info('✅ [Razorpay] Subscription authenticated');
        break;
      }

      case 'subscription.activated': {
        const subscription = payload.subscription?.entity;
        if (subscription) {
          const notes = subscription.notes || {};
          const userId = notes.userId;
          const planId = notes.planId;
          const billingPeriod = notes.billingPeriod || 'monthly';

          if (userId && planId) {
            const plan = await storage.getPlan(planId);
            if (plan) {
              const currentPeriodEnd = new Date();
              if (billingPeriod === 'yearly') {
                currentPeriodEnd.setFullYear(currentPeriodEnd.getFullYear() + 1);
              } else {
                currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);
              }

              try {
                await storage.createUserSubscription({
                  userId,
                  planId,
                  status: 'active',
                  currentPeriodStart: new Date(),
                  currentPeriodEnd,
                  razorpaySubscriptionId: subscription.id,
                  cancelAtPeriodEnd: false,
                  billingPeriod,
                });
              } catch (error: any) {
                if (!error.message?.includes('unique') && !error.message?.includes('duplicate')) {
                  throw error;
                }
              }

              await storage.updateUser(userId, {
                planType: plan.name,
                planExpiresAt: currentPeriodEnd,
              });

              await NotificationService.notifyMembershipUpgraded(userId, plan.name);

              // Log payment transaction
              const userSub = await storage.getUserSubscription(userId);
              const payment = payload.payment?.entity;
              const inrAmount = billingPeriod === 'yearly' 
                ? plan.razorpayYearlyPrice 
                : plan.razorpayMonthlyPrice;
              try {
                const newTransaction = await storage.createPaymentTransaction({
                  userId,
                  type: 'subscription',
                  gateway: 'razorpay',
                  gatewayTransactionId: payment?.id || subscription.id,
                  gatewaySubscriptionId: subscription.id,
                  amount: inrAmount ? inrAmount.toString() : '0',
                  currency: 'INR',
                  planId,
                  subscriptionId: userSub?.id,
                  description: `${plan.displayName} Subscription`,
                  billingPeriod,
                  status: 'completed',
                  completedAt: new Date(),
                });
                logger.info(`✅ [Razorpay Webhook] Logged subscription transaction for user ${userId}`);
                
                // Generate invoice and send purchase confirmation email
                try {
                  await generateInvoiceForTransaction(newTransaction.id);
                  await emailService.sendPurchaseConfirmation(newTransaction.id);
                  logger.info(`✅ [Razorpay] Purchase confirmation email sent for transaction ${newTransaction.id}`);
                } catch (emailError: any) {
                  logger.error(`❌ [Razorpay] Failed to send purchase confirmation email:`);
                }
              } catch (txError: any) {
                logger.error('Failed to log payment transaction:', txError);
              }
            }
          }
        }
        break;
      }

      case 'subscription.charged': {
        const subscription = payload.subscription?.entity;
        const payment = payload.payment?.entity;

        if (subscription && payment) {
          const notes = subscription.notes || {};
          const userId = notes.userId;

          if (userId) {
            const userSub = await storage.getUserSubscription(userId);
            if (userSub) {
              const billingPeriod = userSub.billingPeriod || 'monthly';
              const newPeriodEnd = new Date();
              if (billingPeriod === 'yearly') {
                newPeriodEnd.setFullYear(newPeriodEnd.getFullYear() + 1);
              } else {
                newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);
              }

              await storage.updateUserSubscription(userSub.id, {
                status: 'active',
                currentPeriodStart: new Date(),
                currentPeriodEnd: newPeriodEnd,
              });

              // Get the plan name from the subscription to ensure proper planType sync
              const plan = userSub.planId ? await storage.getPlan(userSub.planId) : null;
              const planName = plan?.name || 'pro';
              
              await storage.updateUser(userId, {
                planType: planName,
                planExpiresAt: newPeriodEnd,
              });

              // Log payment transaction for renewal
              if (plan) {
                const inrAmount = (userSub.billingPeriod === 'yearly')
                  ? plan.razorpayYearlyPrice
                  : plan.razorpayMonthlyPrice;
                try {
                  const renewalTransaction = await storage.createPaymentTransaction({
                    userId,
                    type: 'subscription',
                    gateway: 'razorpay',
                    gatewayTransactionId: payment.id,
                    gatewaySubscriptionId: subscription.id,
                    amount: inrAmount ? inrAmount.toString() : '0',
                    currency: 'INR',
                    planId: plan.id,
                    subscriptionId: userSub.id,
                    description: `${plan.displayName} Subscription Renewal`,
                    billingPeriod: userSub.billingPeriod || 'monthly',
                    status: 'completed',
                    completedAt: new Date(),
                  });
                  logger.info(`✅ [Razorpay Webhook] Logged renewal transaction for user ${userId}`);
                  
                  // Generate invoice and send purchase confirmation email for renewal
                  try {
                    await generateInvoiceForTransaction(renewalTransaction.id);
                    await emailService.sendPurchaseConfirmation(renewalTransaction.id);
                    logger.info(`✅ [Razorpay] Renewal confirmation email sent for transaction ${renewalTransaction.id}`);
                  } catch (emailError: any) {
                    logger.error(`❌ [Razorpay] Failed to send renewal confirmation email:`);
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

      case 'subscription.pending': {
        const subscription = payload.subscription?.entity;
        if (subscription) {
          const notes = subscription.notes || {};
          const userId = notes.userId;

          if (userId) {
            const userSub = await storage.getUserSubscription(userId);
            if (userSub) {
              await storage.updateUserSubscription(userSub.id, {
                status: 'pending',
              });
            }
          }
        }
        break;
      }

      case 'subscription.halted': {
        const subscription = payload.subscription?.entity;
        if (subscription) {
          const notes = subscription.notes || {};
          const userId = notes.userId;

          if (userId) {
            const userSub = await storage.getUserSubscription(userId);
            if (userSub) {
              await storage.updateUserSubscription(userSub.id, {
                status: 'cancelled',
              });

              await storage.updateUser(userId, {
                planType: 'free',
                planExpiresAt: null,
              });
            }
          }
        }
        break;
      }

      case 'subscription.cancelled': {
        const subscription = payload.subscription?.entity;
        if (subscription) {
          const notes = subscription.notes || {};
          const userId = notes.userId;

          if (userId) {
            const userSub = await storage.getUserSubscription(userId);
            if (userSub) {
              await storage.updateUserSubscription(userSub.id, {
                status: 'expired',
              });

              await storage.updateUser(userId, {
                planType: 'free',
                planExpiresAt: null,
              });

              try {
                const { db } = await import('../db');
                const { agents, llmModels } = await import('@shared/schema');
                const { eq, and } = await import('drizzle-orm');

                const userAgents = await storage.getUserAgents(userId);

                const proModels = await db
                  .select()
                  .from(llmModels)
                  .where(eq(llmModels.tier, 'pro'));

                const proModelIds = proModels.map(m => m.modelId);

                const agentsToUpdate = userAgents.filter(agent => {
                  const currentModel = (agent.config as any)?.model || agent.llmModel;
                  return currentModel && proModelIds.includes(currentModel);
                });

                if (agentsToUpdate.length > 0) {
                  const activeFreeModels = await db
                    .select()
                    .from(llmModels)
                    .where(and(
                      eq(llmModels.tier, 'free'),
                      eq(llmModels.isActive, true)
                    ))
                    .orderBy(llmModels.sortOrder, llmModels.name)
                    .limit(1);

                  if (activeFreeModels.length > 0) {
                    const defaultFreeModel = activeFreeModels[0].modelId;

                    for (const agent of agentsToUpdate) {
                      const updatedConfig = {
                        ...(typeof agent.config === 'object' ? agent.config : {}),
                        model: defaultFreeModel
                      } as any;

                      await db
                        .update(agents)
                        .set({
                          config: updatedConfig,
                          llmModel: defaultFreeModel,
                          updatedAt: new Date()
                        })
                        .where(eq(agents.id, agent.id));
                    }
                  }
                }
              } catch (error) {
                logger.error('Error downgrading user agents:', error);
              }
            }
          }
        }
        break;
      }

      case 'order.paid': {
        const order = payload.order?.entity;
        const payment = payload.payment?.entity;

        if (order && payment) {
          const notes = order.notes || {};
          const userId = notes.userId;
          const packageId = notes.packageId;
          const credits = parseInt(notes.credits || '0', 10);

          if (userId && packageId && credits > 0) {
            try {
              await storage.addCreditsAtomic(userId, credits, `Purchased ${credits} credits`, payment.id);
              import('../services/sip-credit-guard').then(({ reconnectAfterRecharge }) => reconnectAfterRecharge(userId)).catch(() => {});

              // Log payment transaction for credits
              const pkg = await storage.getCreditPackage(packageId);
              if (pkg) {
                const inrAmount = order.amount ? (order.amount / 100) : 0;
                try {
                  const creditTransaction = await storage.createPaymentTransaction({
                    userId,
                    type: 'credits',
                    gateway: 'razorpay',
                    gatewayTransactionId: payment.id,
                    amount: inrAmount.toFixed(2),
                    currency: 'INR',
                    creditPackageId: packageId,
                    description: `${pkg.name} - ${credits} Credits`,
                    creditsAwarded: credits,
                    status: 'completed',
                    completedAt: new Date(),
                  });
                  logger.info(`✅ [Razorpay Webhook] Logged credits transaction for user ${userId}`);
                  
                  // Generate invoice and send purchase confirmation email
                  try {
                    await generateInvoiceForTransaction(creditTransaction.id);
                    await emailService.sendPurchaseConfirmation(creditTransaction.id);
                    logger.info(`✅ [Razorpay] Credits purchase confirmation email sent for transaction ${creditTransaction.id}`);
                  } catch (emailError: any) {
                    logger.error(`❌ [Razorpay] Failed to send credits purchase confirmation email:`);
                  }
                } catch (txError: any) {
                  logger.error('Failed to log payment transaction:', txError);
                }
              }
            } catch (error: any) {
              if (!error.message?.includes('unique') && !error.message?.includes('duplicate')) {
                throw error;
              }
            }
          }
        }
        break;
      }

      case 'payment.captured': {
        logger.info('✅ [Razorpay] Payment captured');
        break;
      }

      case 'payment.failed': {
        const payment = payload.payment?.entity;
        logger.error('❌ [Razorpay] Payment failed:', payment?.error_description);
        
        // Try to find the user and send payment failed email
        try {
          const notes = payment?.notes || {};
          const userId = notes.userId;
          if (userId) {
            const failedAmount = ((payment?.amount || 0) / 100).toFixed(2);
            await emailService.sendPaymentFailed(userId, failedAmount, payment?.error_description || 'Payment failed');
            logger.info(`✅ [Razorpay] Payment failed email sent to user ${userId}`);
          }
        } catch (emailError: any) {
          logger.error(`❌ [Razorpay] Failed to send payment failed email:`);
        }
        break;
      }

      case 'refund.created': {
        // Handle external refund (not initiated via our admin API)
        const refund = payload.refund?.entity;
        const paymentId = refund?.payment_id;
        
        logger.info(`🔄 [Razorpay] External refund created: ${refund?.id} for payment ${paymentId}`);
        
        if (paymentId && refund) {
          try {
            // Find the original transaction
            const transaction = await storage.getPaymentTransactionByGatewayId('razorpay', paymentId);
            
            if (transaction) {
              // Check if we already have a refund for this transaction
              const existingRefunds = await storage.getTransactionRefunds(transaction.id);
              if (existingRefunds.length > 0) {
                logger.warn(`ℹ️ [Razorpay] Refund already exists for payment ${paymentId}, skipping`);
                break;
              }
              
              const userId = transaction.userId;
              
              // Reverse credits if it was a credit purchase using centralized applyRefund
              let creditsReversed = 0;
              if (transaction.type === 'credits' && transaction.creditsAwarded) {
                const refundResult = await applyRefund({
                  userId,
                  creditsToReverse: transaction.creditsAwarded,
                  gateway: 'razorpay',
                  gatewayRefundId: refund.id,
                  transactionId: transaction.id,
                  reason: 'External refund via Razorpay',
                });
                
                if (refundResult.success && !refundResult.alreadyProcessed) {
                  creditsReversed = refundResult.creditsReversed;
                  logger.info(`🔄 [Razorpay] Reversed ${creditsReversed} credits for user ${userId}. Transaction logged.`);
                }
              }
              
              // Create refund record
              await storage.createRefund({
                transactionId: transaction.id,
                userId,
                amount: ((refund.amount || 0) / 100).toFixed(2),
                currency: refund.currency?.toUpperCase() || transaction.currency,
                gateway: 'razorpay',
                gatewayRefundId: refund.id,
                reason: 'gateway_refund',
                initiatedBy: 'gateway',
                status: 'completed',
                creditsReversed: creditsReversed > 0 ? creditsReversed : undefined,
                metadata: {
                  userSuspended: false,
                  refundReason: refund.notes?.reason || 'external_refund',
                },
              });
              
              // Update transaction status
              await storage.updatePaymentTransaction(transaction.id, {
                status: 'refunded',
              });
              
              logger.info(`✅ [Razorpay] External refund processed for user ${userId}. Payment: ${paymentId}`);
            }
          } catch (error: any) {
            logger.error('Error processing external refund:', error);
          }
        }
        break;
      }

      case 'payment.dispute.created': {
        // Handle chargeback/dispute - suspend user account
        const dispute = payload.dispute?.entity;
        const paymentId = dispute?.payment_id;
        
        logger.warn(`🚨 [Razorpay] Dispute created: ${dispute?.id} for payment ${paymentId}`);
        
        if (paymentId && dispute) {
          try {
            // Find the original transaction
            const transaction = await storage.getPaymentTransactionByGatewayId('razorpay', paymentId);
            
            if (transaction) {
              const userId = transaction.userId;
              
              // Reverse credits if it was a credit purchase using centralized applyRefund
              let creditsReversed = 0;
              if (transaction.type === 'credits' && transaction.creditsAwarded) {
                const refundResult = await applyRefund({
                  userId,
                  creditsToReverse: transaction.creditsAwarded,
                  gateway: 'razorpay',
                  gatewayRefundId: dispute.id,
                  transactionId: transaction.id,
                  reason: 'Chargeback dispute',
                });
                
                if (refundResult.success && !refundResult.alreadyProcessed) {
                  creditsReversed = refundResult.creditsReversed;
                  logger.info(`🔄 [Razorpay] Reversed ${creditsReversed} credits for user ${userId}. Transaction logged.`);
                }
              }
              
              // Create refund record
              await storage.createRefund({
                transactionId: transaction.id,
                userId,
                amount: ((dispute.amount || 0) / 100).toFixed(2),
                currency: dispute.currency?.toUpperCase() || transaction.currency,
                gateway: 'razorpay',
                gatewayRefundId: dispute.id,
                reason: 'chargeback',
                initiatedBy: 'gateway',
                status: 'completed',
                creditsReversed: creditsReversed > 0 ? creditsReversed : undefined,
                metadata: {
                  userSuspended: true,
                  disputeReason: dispute.reason_code || 'unknown',
                  disputePhase: dispute.phase,
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
                await emailService.sendAccountSuspended(userId, `Chargeback dispute: ${dispute.reason_code || 'Unknown reason'}`);
                logger.info(`✅ [Razorpay] Account suspended email sent to user ${userId}`);
              } catch (emailError: any) {
                logger.error(`❌ [Razorpay] Failed to send account suspended email:`);
              }
              
              logger.warn(`⛔ [Razorpay] User ${userId} suspended due to chargeback. Dispute ID: ${dispute.id}, Reason: ${dispute.reason_code}`);
            } else {
              logger.warn(`⚠️ [Razorpay] No transaction found for payment ${paymentId}`);
            }
          } catch (error: any) {
            logger.error('Error processing chargeback:', error);
          }
        }
        break;
      }

      default:
        logger.warn(`ℹ️ [Razorpay] Unhandled event type: ${eventType}`);
    }

    res.json({ received: true });
  } catch (error: any) {
    logger.error('Razorpay webhook error:', error);
    
    const event = req.body;
    await queueFailedWebhook(
      'razorpay',
      event?.event || 'unknown',
      event?.payload?.payment?.entity?.id || event?.payload?.subscription?.entity?.id || `razorpay_${Date.now()}`,
      event?.payload || event,
      error.message || 'Unknown error'
    );
    
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
