'use strict';
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
import express, { Request, Response, Router } from 'express';
import { storage } from '../storage';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { webhookRateLimiter } from '../middleware/rateLimiter';
import { NotificationService } from '../services/notification-service';
import { hasActiveMembership, syncUserWithSubscription } from '../services/membership-service';
import {
  getPayPalClient,
  isPayPalEnabled,
  getPayPalCurrency,
  getPayPalConfig,
  getSupportedCurrencies,
  createPayPalOrder,
  capturePayPalOrder,
  fetchPayPalOrder,
  createPayPalSubscription,
  cancelPayPalSubscription,
  fetchPayPalSubscription,
  verifyPayPalWebhookSignature,
  resetPayPalClient
} from '../services/paypal-service';
import { queueFailedWebhook } from '../services/webhook-retry-service';
import { emailService } from '../services/email-service';
import { generateInvoiceForTransaction } from '../services/invoice-service';
import { FRONTEND_URL } from '../engines/payment/webhook-helper';
import { applyRefund } from '../services/credit-service';
import { logger } from '../utils/logger';

const router: Router = express.Router();

router.get('/config', async (_req: Request, res: Response) => {
  try {
    const config = await getPayPalConfig();
    const currencies = getSupportedCurrencies();
    res.json({
      ...config,
      supportedCurrencies: currencies,
    });
  } catch (error: any) {
    logger.error('Error fetching PayPal config:', error);
    res.status(500).json({ error: 'Failed to fetch PayPal configuration' });
  }
});

router.post('/create-order', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const isEnabled = await isPayPalEnabled();
    if (!isEnabled) {
      return res.status(400).json({ error: 'PayPal payments are not enabled' });
    }

    const client = await getPayPalClient();
    if (!client) {
      return res.status(400).json({ error: 'PayPal is not configured' });
    }

    const { packageId } = req.body;
    const userId = req.userId!;

    if (!packageId) {
      return res.status(400).json({ error: 'Package ID required' });
    }

    const hasMembership = await hasActiveMembership(userId);
    if (!hasMembership) {
      return res.status(403).json({
        error: 'Active Pro membership required to purchase credits. Please subscribe to a plan first.'
      });
    }

    const user = await storage.getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const pkg = await storage.getCreditPackage(packageId);
    if (!pkg) {
      return res.status(404).json({ error: 'Credit package not found' });
    }

    const currencyConfig = await getPayPalCurrency();
    const price = pkg.paypalPrice ? parseFloat(pkg.paypalPrice.toString()) : parseFloat(pkg.price.toString());

    const order = await createPayPalOrder({
      amount: price,
      currency: currencyConfig.currency,
      description: `${pkg.name} - ${pkg.credits} Credits`,
      returnUrl: `${FRONTEND_URL}/app/billing?paypal=success`,
      cancelUrl: `${FRONTEND_URL}/app/billing?paypal=cancelled`,
      customId: JSON.stringify({ userId, packageId, credits: pkg.credits, type: 'credits' }),
    });

    const approvalLink = order.links?.find((link: any) => link.rel === 'approve')?.href;

    res.json({
      orderId: order.id,
      approvalUrl: approvalLink,
      packageName: pkg.name,
      credits: pkg.credits,
      amount: price,
      currency: currencyConfig.currency,
      currencySymbol: currencyConfig.symbol,
    });
  } catch (error: any) {
    logger.error('Create PayPal order error:', error);
    res.status(500).json({ error: 'Failed to create PayPal order' });
  }
});

router.post('/capture-order', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const client = await getPayPalClient();
    if (!client) {
      return res.status(400).json({ error: 'PayPal is not configured' });
    }

    const { orderId } = req.body;
    const userId = req.userId!;

    if (!orderId) {
      return res.status(400).json({ error: 'Order ID required' });
    }

    const capturedOrder = await capturePayPalOrder(orderId);

    if (capturedOrder.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    const customId = capturedOrder.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id ||
                     capturedOrder.purchase_units?.[0]?.custom_id;
    
    if (!customId) {
      return res.status(400).json({ error: 'Invalid order metadata' });
    }

    let metadata;
    try {
      metadata = JSON.parse(customId);
    } catch {
      return res.status(400).json({ error: 'Invalid order metadata format' });
    }

    if (metadata.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (metadata.type === 'credits') {
      const pkg = await storage.getCreditPackage(metadata.packageId);
      if (!pkg) {
        return res.status(404).json({ error: 'Package not found' });
      }

      const captureId = capturedOrder.purchase_units?.[0]?.payments?.captures?.[0]?.id;
      
      try {
        await storage.addCreditsAtomic(userId, metadata.credits, `Purchased ${pkg.name} via PayPal`, `paypal_${captureId}`);
        import('../services/sip-credit-guard').then(({ reconnectAfterRecharge }) => reconnectAfterRecharge(userId)).catch(() => {});
        
        // Log payment transaction for credits
        const currencyConfig = await getPayPalCurrency();
        const capturedAmount = capturedOrder.purchase_units?.[0]?.payments?.captures?.[0]?.amount;
        const amount = capturedAmount?.value || '0';
        try {
          const creditTransaction = await storage.createPaymentTransaction({
            userId,
            type: 'credits',
            gateway: 'paypal',
            gatewayTransactionId: captureId || orderId,
            amount,
            currency: (capturedAmount?.currency_code || currencyConfig.currency).toUpperCase(),
            creditPackageId: metadata.packageId,
            description: `${pkg.name} - ${metadata.credits} Credits`,
            creditsAwarded: metadata.credits,
            status: 'completed',
            completedAt: new Date(),
          });
          logger.info(`✅ [PayPal] Logged credits transaction for user ${userId}`);
          
          // Generate invoice and send purchase confirmation email
          try {
            await generateInvoiceForTransaction(creditTransaction.id);
            await emailService.sendPurchaseConfirmation(creditTransaction.id);
            logger.info(`✅ [PayPal] Credits purchase confirmation email sent for transaction ${creditTransaction.id}`);
          } catch (emailError: any) {
            logger.error(`❌ [PayPal] Failed to send credits purchase confirmation email:`);
          }
        } catch (txError: any) {
          logger.error('Failed to log payment transaction:', txError);
        }

        res.json({ success: true, credits: metadata.credits });
      } catch (error: any) {
        if (error.message?.includes('unique') || error.message?.includes('duplicate')) {
          res.json({ success: true, alreadyProcessed: true });
        } else {
          throw error;
        }
      }
    } else {
      res.json({ success: true });
    }
  } catch (error: any) {
    logger.error('Capture PayPal order error:', error);
    res.status(500).json({ error: 'Failed to capture PayPal order' });
  }
});

router.post('/create-subscription', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const isEnabled = await isPayPalEnabled();
    if (!isEnabled) {
      return res.status(400).json({ error: 'PayPal payments are not enabled' });
    }

    const client = await getPayPalClient();
    if (!client) {
      return res.status(400).json({ error: 'PayPal is not configured' });
    }

    const { planId, billingPeriod = 'monthly' } = req.body;
    const userId = req.userId!;

    if (!planId) {
      return res.status(400).json({ error: 'Plan ID required' });
    }

    const user = await storage.getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const plan = await storage.getPlan(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const paypalPlanId = billingPeriod === 'yearly' ? plan.paypalYearlyPlanId : plan.paypalMonthlyPlanId;
    if (!paypalPlanId) {
      return res.status(400).json({ error: 'PayPal plan not configured for this billing period' });
    }

    const appNameSetting = await storage.getGlobalSetting('app_name');
    const brandName = (appNameSetting?.value as string) || '';
    
    const subscription = await createPayPalSubscription({
      planId: paypalPlanId,
      subscriber: {
        email_address: user.email,
        name: user.name ? { given_name: user.name.split(' ')[0], surname: user.name.split(' ').slice(1).join(' ') || '' } : undefined,
      },
      applicationContext: {
        brand_name: brandName,
        return_url: `${FRONTEND_URL}/app/billing?paypal_subscription=success&plan_id=${planId}&billing_period=${billingPeriod}`,
        cancel_url: `${FRONTEND_URL}/app/billing?paypal_subscription=cancelled`,
        user_action: 'SUBSCRIBE_NOW',
      },
    });

    const approvalLink = subscription.links?.find((link: any) => link.rel === 'approve')?.href;

    res.json({
      subscriptionId: subscription.id,
      approvalUrl: approvalLink,
      planName: plan.displayName,
      billingPeriod,
    });
  } catch (error: any) {
    logger.error('Create PayPal subscription error:', error);
    res.status(500).json({ error: 'Failed to create PayPal subscription' });
  }
});

router.post('/confirm-subscription', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const client = await getPayPalClient();
    if (!client) {
      return res.status(400).json({ error: 'PayPal is not configured' });
    }

    const { subscriptionId, planId, billingPeriod = 'monthly' } = req.body;
    const userId = req.userId!;

    if (!subscriptionId || !planId) {
      return res.status(400).json({ error: 'Subscription ID and Plan ID required' });
    }

    const subscription = await fetchPayPalSubscription(subscriptionId);
    if (subscription.status !== 'ACTIVE' && subscription.status !== 'APPROVED') {
      return res.status(400).json({ error: 'Subscription not active' });
    }

    const plan = await storage.getPlan(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const startDate = new Date();
    const endDate = new Date(startDate);
    if (billingPeriod === 'yearly') {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else {
      endDate.setMonth(endDate.getMonth() + 1);
    }

    const existingSubscription = await storage.getUserSubscription(userId);
    if (existingSubscription?.paypalSubscriptionId && existingSubscription.paypalSubscriptionId !== subscriptionId) {
      try {
        await cancelPayPalSubscription(existingSubscription.paypalSubscriptionId, 'Upgraded to new plan');
      } catch (e) {
        logger.warn('Failed to cancel old PayPal subscription:', e);
      }
    }

    if (existingSubscription) {
      await storage.updateUserSubscription(existingSubscription.id, {
        planId: plan.id,
        status: 'active',
        currentPeriodStart: startDate,
        currentPeriodEnd: endDate,
        paypalSubscriptionId: subscriptionId,
        billingPeriod,
        cancelAtPeriodEnd: false,
      });
    } else {
      await storage.createUserSubscription({
        userId,
        planId: plan.id,
        status: 'active',
        currentPeriodStart: startDate,
        currentPeriodEnd: endDate,
        paypalSubscriptionId: subscriptionId,
        billingPeriod,
        cancelAtPeriodEnd: false,
      });
    }

    await syncUserWithSubscription(userId);

    await NotificationService.notifyMembershipUpgraded(userId, plan.displayName);

    // Log payment transaction for subscription
    const userSub = await storage.getUserSubscription(userId);
    const currencyConfig = await getPayPalCurrency();
    const price = billingPeriod === 'yearly'
      ? plan.paypalYearlyPrice || plan.yearlyPrice
      : plan.paypalMonthlyPrice || plan.monthlyPrice;
    try {
      const newTransaction = await storage.createPaymentTransaction({
        userId,
        type: 'subscription',
        gateway: 'paypal',
        gatewayTransactionId: subscriptionId,
        gatewaySubscriptionId: subscriptionId,
        amount: price ? price.toString() : '0',
        currency: currencyConfig.currency.toUpperCase(),
        planId: plan.id,
        subscriptionId: userSub?.id,
        description: `${plan.displayName} Subscription`,
        billingPeriod,
        status: 'completed',
        completedAt: new Date(),
      });
      logger.info(`✅ [PayPal] Logged subscription transaction for user ${userId}`);
      
      // Generate invoice and send purchase confirmation email
      try {
        await generateInvoiceForTransaction(newTransaction.id);
        await emailService.sendPurchaseConfirmation(newTransaction.id);
        logger.info(`✅ [PayPal] Purchase confirmation email sent for transaction ${newTransaction.id}`);
      } catch (emailError: any) {
        logger.error(`❌ [PayPal] Failed to send purchase confirmation email:`);
      }
    } catch (txError: any) {
      logger.error('Failed to log payment transaction:', txError);
    }

    res.json({ success: true, planName: plan.displayName });
  } catch (error: any) {
    logger.error('Confirm PayPal subscription error:', error);
    res.status(500).json({ error: 'Failed to confirm PayPal subscription' });
  }
});

router.post('/cancel-subscription', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const client = await getPayPalClient();
    if (!client) {
      return res.status(400).json({ error: 'PayPal is not configured' });
    }

    const userId = req.userId!;
    const { cancelImmediately = false } = req.body;

    const subscription = await storage.getUserSubscription(userId);
    if (!subscription?.paypalSubscriptionId) {
      return res.status(404).json({ error: 'No active PayPal subscription found' });
    }

    if (cancelImmediately) {
      await cancelPayPalSubscription(subscription.paypalSubscriptionId, 'User cancelled subscription');
      
      const freePlan = await storage.getPlanByName('free');
      if (freePlan) {
        await storage.updateUserSubscription(subscription.id, {
          planId: freePlan.id,
          status: 'cancelled',
          paypalSubscriptionId: null,
        });
        await syncUserWithSubscription(userId);
      }
    } else {
      await storage.updateUserSubscription(subscription.id, {
        cancelAtPeriodEnd: true,
      });
    }

    res.json({ 
      success: true, 
      cancelAtPeriodEnd: !cancelImmediately,
      currentPeriodEnd: subscription.currentPeriodEnd,
    });
  } catch (error: any) {
    logger.error('Cancel PayPal subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel PayPal subscription' });
  }
});

router.post('/webhook', webhookRateLimiter, express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    
    const isValid = await verifyPayPalWebhookSignature(rawBody, req.headers);
    if (!isValid) {
      logger.warn('⚠️ [PayPal] Invalid webhook signature - rejecting');
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const webhookEvent = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    if (!webhookEvent || !webhookEvent.event_type) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    logger.info(`📥 [PayPal] Webhook received: ${webhookEvent.event_type}`);

    switch (webhookEvent.event_type) {
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
      case 'BILLING.SUBSCRIPTION.RENEWED':
        {
          const subscriptionId = webhookEvent.resource?.id;
          if (subscriptionId) {
            const allSubscriptions = await storage.getAllUserSubscriptions();
            const subscription = allSubscriptions.find(s => s.paypalSubscriptionId === subscriptionId);
            if (subscription) {
              const startDate = new Date();
              const endDate = new Date(startDate);
              if (subscription.billingPeriod === 'yearly') {
                endDate.setFullYear(endDate.getFullYear() + 1);
              } else {
                endDate.setMonth(endDate.getMonth() + 1);
              }

              await storage.updateUserSubscription(subscription.id, {
                status: 'active',
                currentPeriodStart: startDate,
                currentPeriodEnd: endDate,
                cancelAtPeriodEnd: false,
              });

              await syncUserWithSubscription(subscription.userId);

              // Log payment transaction for subscription renewal
              const plan = subscription.planId ? await storage.getPlan(subscription.planId) : null;
              if (plan) {
                const currencyConfig = await getPayPalCurrency();
                const price = (subscription.billingPeriod === 'yearly')
                  ? plan.paypalYearlyPrice || plan.yearlyPrice
                  : plan.paypalMonthlyPrice || plan.monthlyPrice;
                try {
                  const webhookTransaction = await storage.createPaymentTransaction({
                    userId: subscription.userId,
                    type: 'subscription',
                    gateway: 'paypal',
                    gatewayTransactionId: webhookEvent.resource?.id || subscriptionId,
                    gatewaySubscriptionId: subscriptionId,
                    amount: price ? price.toString() : '0',
                    currency: currencyConfig.currency.toUpperCase(),
                    planId: plan.id,
                    subscriptionId: subscription.id,
                    description: webhookEvent.event_type === 'BILLING.SUBSCRIPTION.RENEWED' 
                      ? `${plan.displayName} Subscription Renewal` 
                      : `${plan.displayName} Subscription`,
                    billingPeriod: subscription.billingPeriod || 'monthly',
                    status: 'completed',
                    completedAt: new Date(),
                  });
                  logger.info(`✅ [PayPal Webhook] Logged subscription transaction for user ${subscription.userId}`);
                  
                  // Generate invoice and send purchase confirmation email
                  try {
                    await generateInvoiceForTransaction(webhookTransaction.id);
                    await emailService.sendPurchaseConfirmation(webhookTransaction.id);
                    logger.info(`✅ [PayPal] Subscription confirmation email sent for transaction ${webhookTransaction.id}`);
                  } catch (emailError: any) {
                    logger.error(`❌ [PayPal] Failed to send subscription confirmation email:`);
                  }
                } catch (txError: any) {
                  logger.error('Failed to log payment transaction:', txError);
                }
              }
            }
          }
        }
        break;

      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.EXPIRED':
        {
          const subscriptionId = webhookEvent.resource?.id;
          if (subscriptionId) {
            const allSubscriptions = await storage.getAllUserSubscriptions();
            const subscription = allSubscriptions.find(s => s.paypalSubscriptionId === subscriptionId);
            if (subscription) {
              const freePlan = await storage.getPlanByName('free');
              if (freePlan) {
                await storage.updateUserSubscription(subscription.id, {
                  planId: freePlan.id,
                  status: 'cancelled',
                  paypalSubscriptionId: null,
                });
                await syncUserWithSubscription(subscription.userId);
              }
            }
          }
        }
        break;

      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
        {
          const subscriptionId = webhookEvent.resource?.id;
          if (subscriptionId) {
            const allSubscriptions = await storage.getAllUserSubscriptions();
            const subscription = allSubscriptions.find(s => s.paypalSubscriptionId === subscriptionId);
            if (subscription) {
              await NotificationService.notifyPaymentFailed(subscription.userId);
              
              // Send payment failed email
              try {
                const failedAmount = webhookEvent.resource?.billing_info?.last_payment?.amount?.value || '0';
                await emailService.sendPaymentFailed(subscription.userId, failedAmount, 'Subscription payment failed');
                logger.info(`✅ [PayPal] Payment failed email sent to user ${subscription.userId}`);
              } catch (emailError: any) {
                logger.error(`❌ [PayPal] Failed to send payment failed email:`);
              }
            }
          }
        }
        break;

      case 'PAYMENT.CAPTURE.COMPLETED':
        logger.info('📥 [PayPal] Payment capture completed');
        break;

      case 'PAYMENT.CAPTURE.REFUNDED':
        {
          // Handle external refund (not initiated via our admin API)
          const capture = webhookEvent.resource;
          const captureId = capture?.id;
          
          logger.info(`🔄 [PayPal] External refund received for capture: ${captureId}`);
          
          if (captureId) {
            try {
              // Find the original transaction
              const transaction = await storage.getPaymentTransactionByGatewayId('paypal', captureId);
              
              if (transaction) {
                // Check if we already have a refund for this transaction
                const existingRefunds = await storage.getTransactionRefunds(transaction.id);
                if (existingRefunds.length > 0) {
                  logger.warn(`ℹ️ [PayPal] Refund already exists for capture ${captureId}, skipping`);
                  break;
                }
                
                const userId = transaction.userId;
                
                // Reverse credits if it was a credit purchase
                let creditsReversed = 0;
                if (transaction.type === 'credits' && transaction.creditsAwarded) {
                  const refundResult = await applyRefund({
                    userId,
                    creditsToReverse: transaction.creditsAwarded,
                    gateway: 'paypal',
                    gatewayRefundId: webhookEvent.id || `paypal_refund_${captureId}`,
                    transactionId: transaction.id,
                    reason: 'External refund via PayPal',
                  });
                  
                  if (refundResult.success && !refundResult.alreadyProcessed) {
                    creditsReversed = refundResult.creditsReversed;
                    logger.info(`🔄 [PayPal] Reversed ${creditsReversed} credits for user ${userId}. Transaction logged.`);
                  }
                }
                
                // Create refund record
                const refundAmount = capture?.amount?.value || transaction.amount;
                await storage.createRefund({
                  transactionId: transaction.id,
                  userId,
                  amount: refundAmount.toString(),
                  currency: capture?.amount?.currency_code || transaction.currency,
                  gateway: 'paypal',
                  gatewayRefundId: webhookEvent.id || `paypal_refund_${captureId}`,
                  reason: 'gateway_refund',
                  initiatedBy: 'gateway',
                  status: 'completed',
                  creditsReversed: creditsReversed > 0 ? creditsReversed : undefined,
                  metadata: {
                    userSuspended: false,
                    refundReason: 'external_refund',
                  },
                });
                
                // Update transaction status
                await storage.updatePaymentTransaction(transaction.id, {
                  status: 'refunded',
                });
                
                logger.info(`✅ [PayPal] External refund processed for user ${userId}. Capture: ${captureId}`);
              }
            } catch (error: any) {
              logger.error('Error processing external refund:', error);
            }
          }
        }
        break;

      case 'CUSTOMER.DISPUTE.CREATED':
        {
          // Handle chargeback/dispute - suspend user account
          const dispute = webhookEvent.resource;
          const disputeId = dispute?.dispute_id;
          
          logger.warn(`🚨 [PayPal] Dispute created: ${disputeId}`);
          
          // Get the transaction ID from the disputed_transactions array
          const disputedTransaction = dispute?.disputed_transactions?.[0];
          const captureId = disputedTransaction?.seller_transaction_id || disputedTransaction?.buyer_transaction_id;
          
          if (captureId) {
            try {
              // Find the original transaction
              const transaction = await storage.getPaymentTransactionByGatewayId('paypal', captureId);
              
              if (transaction) {
                const userId = transaction.userId;
                
                // Reverse credits if it was a credit purchase
                let creditsReversed = 0;
                if (transaction.type === 'credits' && transaction.creditsAwarded) {
                  const refundResult = await applyRefund({
                    userId,
                    creditsToReverse: transaction.creditsAwarded,
                    gateway: 'paypal',
                    gatewayRefundId: disputeId,
                    transactionId: transaction.id,
                    reason: 'Chargeback dispute',
                  });
                  
                  if (refundResult.success && !refundResult.alreadyProcessed) {
                    creditsReversed = refundResult.creditsReversed;
                    logger.info(`🔄 [PayPal] Reversed ${creditsReversed} credits for user ${userId}. Transaction logged.`);
                  }
                }
                
                // Create refund record
                const disputeAmount = dispute?.dispute_amount?.value || disputedTransaction?.gross_amount?.value || transaction.amount;
                await storage.createRefund({
                  transactionId: transaction.id,
                  userId,
                  amount: disputeAmount.toString(),
                  currency: dispute?.dispute_amount?.currency_code || transaction.currency,
                  gateway: 'paypal',
                  gatewayRefundId: disputeId,
                  reason: 'chargeback',
                  initiatedBy: 'gateway',
                  status: 'completed',
                  creditsReversed: creditsReversed > 0 ? creditsReversed : undefined,
                  metadata: {
                    userSuspended: true,
                    disputeReason: dispute?.reason || 'unknown',
                    disputeStatus: dispute?.status,
                    disputeLifeCycleStage: dispute?.dispute_life_cycle_stage,
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
                  await emailService.sendAccountSuspended(userId, `Chargeback dispute: ${dispute?.reason || 'Unknown reason'}`);
                  logger.info(`✅ [PayPal] Account suspended email sent to user ${userId}`);
                } catch (emailError: any) {
                  logger.error(`❌ [PayPal] Failed to send account suspended email:`);
                }
                
                logger.warn(`⛔ [PayPal] User ${userId} suspended due to chargeback. Dispute ID: ${disputeId}, Reason: ${dispute?.reason}`);
              } else {
                logger.warn(`⚠️ [PayPal] No transaction found for capture ${captureId}`);
              }
            } catch (error: any) {
              logger.error('Error processing chargeback:', error);
            }
          }
        }
        break;

      default:
        logger.warn(`📥 [PayPal] Unhandled webhook event: ${webhookEvent.event_type}`);
    }

    res.status(200).json({ received: true });
  } catch (error: any) {
    logger.error('PayPal webhook error:', error);
    
    const webhookEvent = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    await queueFailedWebhook(
      'paypal',
      webhookEvent?.event_type || 'unknown',
      webhookEvent?.id || `paypal_${Date.now()}`,
      webhookEvent?.resource || webhookEvent,
      error.message || 'Unknown error'
    );
    
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
