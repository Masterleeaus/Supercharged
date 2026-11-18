'use strict';
/**
 * ============================================================
 * © 2025 Titan Zero Private Limited
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

/**
 * Razorpay config, subscription, order and cancel routes. Split out of razorpay-routes.ts;
 * paths, methods, middleware and responses are unchanged. Mounted by razorpay-routes.ts.
 */
import express, { Request, Response, Router } from 'express';
import { storage } from '../storage';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { NotificationService } from '../services/notification-service';
import { hasActiveMembership } from '../services/membership-service';
import { createRazorpaySubscription, createRazorpayOrder, fetchRazorpaySubscription, cancelRazorpaySubscription, verifyPaymentSignature, isRazorpayConfigured, isRazorpayEnabled } from '../services/razorpay-service';
import { logger } from '../utils/logger';

const router: Router = express.Router();

async function getRazorpayKeyId(): Promise<string | null> {
  const setting = await storage.getGlobalSetting('razorpay_key_id');
  return setting?.value as string | null;
}

router.get('/config', async (req: Request, res: Response) => {
  try {
    // Check if Razorpay is enabled (not necessarily the "active" gateway)
    // When both gateways are enabled, Razorpay config should be available
    const isEnabled = await isRazorpayEnabled();
    if (!isEnabled) {
      return res.json({ enabled: false, keyId: null });
    }

    const isConfigured = await isRazorpayConfigured();
    if (!isConfigured) {
      return res.json({ enabled: false, keyId: null });
    }

    const keyId = await getRazorpayKeyId();
    res.json({ enabled: true, keyId });
  } catch (error: any) {
    logger.error('Get Razorpay config error:', error);
    res.status(500).json({ error: 'Failed to get Razorpay config' });
  }
});

router.post('/create-subscription', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    // Check if Razorpay is enabled (not necessarily the "active" gateway)
    // When both gateways are enabled, the user's currency selection determines which to use
    const isEnabled = await isRazorpayEnabled();
    if (!isEnabled) {
      return res.status(400).json({ error: 'Razorpay payments are not enabled' });
    }
    
    const isConfigured = await isRazorpayConfigured();
    if (!isConfigured) {
      return res.status(400).json({ error: 'Razorpay is not configured' });
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

    // Use razorpayPlanId for monthly (field name is razorpayPlanId, not razorpayMonthlyPlanId)
    const razorpayPlanIdToUse = billingPeriod === 'yearly' 
      ? plan.razorpayYearlyPlanId 
      : plan.razorpayPlanId;

    if (!razorpayPlanIdToUse) {
      return res.status(400).json({ 
        error: `Razorpay plan not configured for ${billingPeriod} billing period` 
      });
    }

    const subscription = await createRazorpaySubscription({
      planId: razorpayPlanIdToUse,
      totalCount: billingPeriod === 'yearly' ? 5 : 60,
      customerNotify: true,
      notes: {
        userId,
        planId,
        billingPeriod,
      },
      notifyInfo: {
        notifyEmail: user.email,
      },
    });

    // Return INR amount for Razorpay subscriptions (not USD)
    const inrAmount = billingPeriod === 'yearly' 
      ? plan.razorpayYearlyPrice 
      : plan.razorpayMonthlyPrice;
    
    res.json({
      subscriptionId: subscription.id,
      planName: plan.name,
      billingPeriod,
      amount: inrAmount ? parseFloat(inrAmount.toString()) : 0,
      currency: 'INR',
    });
  } catch (error: any) {
    logger.error('Create Razorpay subscription error:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

router.post('/verify-subscription', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    // Check if Razorpay is enabled (not necessarily the "active" gateway)
    const isEnabled = await isRazorpayEnabled();
    if (!isEnabled) {
      return res.status(400).json({ error: 'Razorpay payments are not enabled' });
    }
    
    const { razorpay_subscription_id, razorpay_payment_id, razorpay_signature } = req.body;
    const userId = req.userId!;

    if (!razorpay_subscription_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment verification parameters' });
    }

    const isValid = await verifyPaymentSignature({
      razorpay_subscription_id,
      razorpay_payment_id,
      razorpay_signature,
    });

    if (!isValid) {
      return res.status(400).json({ error: 'Payment signature verification failed' });
    }

    const subscription = await fetchRazorpaySubscription(razorpay_subscription_id);
    const notes = subscription.notes || {};

    if (notes.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const plan = await storage.getPlan(notes.planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const billingPeriod = notes.billingPeriod || 'monthly';
    const currentPeriodEnd = new Date();
    if (billingPeriod === 'yearly') {
      currentPeriodEnd.setFullYear(currentPeriodEnd.getFullYear() + 1);
    } else {
      currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);
    }

    const existingSub = await storage.getUserSubscription(userId);
    if (existingSub) {
      await storage.updateUserSubscription(existingSub.id, {
        planId: notes.planId,
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd,
        razorpaySubscriptionId: razorpay_subscription_id,
        cancelAtPeriodEnd: false,
        billingPeriod,
      });
    } else {
      await storage.createUserSubscription({
        userId,
        planId: notes.planId,
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd,
        razorpaySubscriptionId: razorpay_subscription_id,
        cancelAtPeriodEnd: false,
        billingPeriod,
      });
    }

    await storage.updateUser(userId, {
      planType: plan.name,
      planExpiresAt: currentPeriodEnd,
    });

    await NotificationService.notifyMembershipUpgraded(userId, plan.name);

    // Log payment transaction
    const userSub = await storage.getUserSubscription(userId);
    const inrAmount = billingPeriod === 'yearly' 
      ? plan.razorpayYearlyPrice 
      : plan.razorpayMonthlyPrice;
    try {
      await storage.createPaymentTransaction({
        userId,
        type: 'subscription',
        gateway: 'razorpay',
        gatewayTransactionId: razorpay_payment_id,
        gatewaySubscriptionId: razorpay_subscription_id,
        amount: inrAmount ? inrAmount.toString() : '0',
        currency: 'INR',
        planId: notes.planId,
        subscriptionId: userSub?.id,
        description: `${plan.displayName} Subscription`,
        billingPeriod,
        status: 'completed',
        completedAt: new Date(),
      });
      logger.info(`✅ [Razorpay] Logged subscription transaction for user ${userId}`);
    } catch (txError: any) {
      logger.error('Failed to log payment transaction:', txError);
    }

    res.json({
      success: true,
      message: 'Subscription activated successfully',
      plan: plan.name,
      expiresAt: currentPeriodEnd,
    });
  } catch (error: any) {
    logger.error('Verify Razorpay subscription error:', error);
    res.status(500).json({ error: 'Failed to verify subscription' });
  }
});

router.post('/create-order', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    // Check if Razorpay is enabled (not necessarily the "active" gateway)
    // When both gateways are enabled, the user's currency selection determines which to use
    const isEnabled = await isRazorpayEnabled();
    if (!isEnabled) {
      return res.status(400).json({ error: 'Razorpay payments are not enabled' });
    }
    
    const isConfigured = await isRazorpayConfigured();
    if (!isConfigured) {
      return res.status(400).json({ error: 'Razorpay is not configured' });
    }
    
    const { packageId } = req.body;
    const userId = req.userId!;

    if (!packageId) {
      return res.status(400).json({ error: 'Package ID required' });
    }

    // Membership requirement - check both subscription table and user fields
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

    // Use razorpayPrice (INR) for Razorpay, not price (USD)
    const inrPrice = pkg.razorpayPrice ? parseFloat(pkg.razorpayPrice.toString()) : 0;
    if (inrPrice <= 0) {
      return res.status(400).json({ error: 'Credit package does not have an INR price configured for Razorpay' });
    }

    // Razorpay receipt must be <= 40 chars, use shortened format
    const shortUserId = userId.slice(-8);
    const timestamp = Date.now().toString().slice(-10);
    const receipt = `cr_${shortUserId}_${timestamp}`;
    
    const order = await createRazorpayOrder({
      amount: inrPrice,
      currency: 'INR',
      receipt,
      notes: {
        userId,
        packageId,
        credits: pkg.credits.toString(),
        type: 'credits',
      },
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      packageName: pkg.name,
      credits: pkg.credits,
    });
  } catch (error: any) {
    logger.error('Create Razorpay order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

router.post('/verify-order', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    // Check if Razorpay is enabled (not necessarily the "active" gateway)
    const isEnabled = await isRazorpayEnabled();
    if (!isEnabled) {
      return res.status(400).json({ error: 'Razorpay payments are not enabled' });
    }
    
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, packageId } = req.body;
    const userId = req.userId!;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !packageId) {
      return res.status(400).json({ error: 'Missing payment verification parameters' });
    }

    const isValid = await verifyPaymentSignature({
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    });

    if (!isValid) {
      return res.status(400).json({ error: 'Payment signature verification failed' });
    }

    const pkg = await storage.getCreditPackage(packageId);
    if (!pkg) {
      return res.status(404).json({ error: 'Package not found' });
    }

    try {
      await storage.addCreditsAtomic(userId, pkg.credits, `Purchased ${pkg.name}`, razorpay_payment_id);
      import('../services/sip-credit-guard').then(({ reconnectAfterRecharge }) => reconnectAfterRecharge(userId)).catch(() => {});

      // Log payment transaction for credits
      const inrPrice = pkg.razorpayPrice ? parseFloat(pkg.razorpayPrice.toString()) : 0;
      try {
        await storage.createPaymentTransaction({
          userId,
          type: 'credits',
          gateway: 'razorpay',
          gatewayTransactionId: razorpay_payment_id,
          amount: inrPrice.toFixed(2),
          currency: 'INR',
          creditPackageId: pkg.id,
          description: `${pkg.name} - ${pkg.credits} Credits`,
          creditsAwarded: pkg.credits,
          status: 'completed',
          completedAt: new Date(),
        });
        logger.info(`✅ [Razorpay] Logged credits transaction for user ${userId}`);
      } catch (txError: any) {
        logger.error('Failed to log payment transaction:', txError);
      }
    } catch (error: any) {
      if (!error.message?.includes('unique') && !error.message?.includes('duplicate')) {
        throw error;
      }
      logger.warn(`Payment ${razorpay_payment_id} already processed, skipping credit addition`);
    }

    const user = await storage.getUser(userId);

    res.json({
      success: true,
      message: 'Credits added successfully',
      credits: pkg.credits,
      newBalance: user?.credits || 0,
    });
  } catch (error: any) {
    logger.error('Verify Razorpay order error:', error);
    res.status(500).json({ error: 'Failed to verify order' });
  }
});

router.post('/cancel-subscription', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    // Check if Razorpay is enabled (not necessarily the "active" gateway)
    const isEnabled = await isRazorpayEnabled();
    if (!isEnabled) {
      return res.status(400).json({ error: 'Razorpay payments are not enabled' });
    }
    
    const userId = req.userId!;

    const subscription = await storage.getUserSubscription(userId);
    if (!subscription || !subscription.razorpaySubscriptionId) {
      return res.status(404).json({ error: 'No active Razorpay subscription found' });
    }

    await cancelRazorpaySubscription(subscription.razorpaySubscriptionId, true);

    await storage.updateUserSubscription(subscription.id, {
      cancelAtPeriodEnd: true,
    });

    res.json({
      message: 'Subscription will be canceled at the end of the billing period',
      currentPeriodEnd: subscription.currentPeriodEnd,
    });
  } catch (error: any) {
    logger.error('Cancel Razorpay subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

export default router;
