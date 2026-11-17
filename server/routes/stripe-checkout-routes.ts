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

/**
 * Stripe checkout, plan-change and cancel routes. Split out of stripe-routes.ts;
 * paths, methods, middleware and responses are unchanged. Mounted by stripe-routes.ts.
 */
import express, { Request, Response, Router } from 'express';
import Stripe from 'stripe';
import { storage } from '../storage';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { hasActiveMembership } from '../services/membership-service';
import { getStripeClient, isStripeEnabled, getStripeCurrency, getStripeConfig, getSupportedCurrencies } from '../services/stripe-service';
import { FRONTEND_URL } from '../engines/payment/webhook-helper';
import { logger } from '../utils/logger';

const router: Router = express.Router();

/**
 * Gets or creates a valid Stripe customer for the user.
 * Handles the case where a stored customer ID is invalid (e.g., after switching Stripe accounts).
 */
async function getOrCreateValidStripeCustomer(
  stripe: Stripe,
  userId: string,
  user: { email: string; name: string; stripeCustomerId?: string | null }
): Promise<string> {
  let stripeCustomerId = user.stripeCustomerId;

  if (stripeCustomerId) {
    try {
      // Verify the customer exists in the current Stripe account
      await stripe.customers.retrieve(stripeCustomerId);
      return stripeCustomerId;
    } catch (error: any) {
      if (error.code === 'resource_missing') {
        logger.warn(`⚠️ [Stripe] Customer ${stripeCustomerId} not found, creating new customer for user ${userId}`);
        // Clear the invalid customer ID
        stripeCustomerId = null;
        await storage.updateUser(userId, { stripeCustomerId: null });
      } else {
        throw error;
      }
    }
  }

  // Create a new customer
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { userId }
  });
  
  logger.info(`✅ [Stripe] Created new customer ${customer.id} for user ${userId}`);
  await storage.updateUser(userId, { stripeCustomerId: customer.id });
  return customer.id;
}

// Stripe config endpoint - returns current configuration
router.get('/config', async (_req: Request, res: Response) => {
  try {
    const config = await getStripeConfig();
    const currencies = getSupportedCurrencies();
    res.json({
      ...config,
      supportedCurrencies: currencies,
    });
  } catch (error: any) {
    logger.error('Error fetching Stripe config:', error);
    res.status(500).json({ error: 'Failed to fetch Stripe configuration' });
  }
});

// Create Payment Intent for embedded checkout (credit purchases)
router.post('/create-payment-intent', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    // Check if Stripe is enabled
    const isEnabled = await isStripeEnabled();
    if (!isEnabled) {
      return res.status(400).json({ error: 'Stripe payments are not enabled' });
    }
    
    const stripe = await getStripeClient();
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe is not configured' });
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

    // Get dynamic currency from settings
    const currencyConfig = await getStripeCurrency();
    
    // Get or create valid Stripe customer (handles invalid customer IDs)
    const stripeCustomerId = await getOrCreateValidStripeCustomer(stripe, userId, user);

    // Create payment intent with dynamic currency
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(parseFloat(pkg.price.toString()) * 100),
      currency: currencyConfig.currency.toLowerCase(),
      customer: stripeCustomerId,
      metadata: {
        userId,
        packageId,
        credits: pkg.credits.toString(),
        type: 'credits',
      },
      automatic_payment_methods: {
        enabled: true,
      },
    });

    res.json({ 
      clientSecret: paymentIntent.client_secret,
      packageName: pkg.name,
      credits: pkg.credits,
      amount: pkg.price,
      currency: currencyConfig.currency,
      currencySymbol: currencyConfig.symbol,
    });
  } catch (error: any) {
    logger.error('Create payment intent error:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

// Confirm payment and add credits
router.post('/confirm-payment', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const stripe = await getStripeClient();
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe is not configured' });
    }
    
    const { paymentIntentId } = req.body;
    const userId = req.userId!;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Payment intent ID required' });
    }

    // Retrieve payment intent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    // Verify this payment belongs to the user
    if (paymentIntent.metadata.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Add credits to user account
    const credits = parseInt(paymentIntent.metadata.credits || '0', 10);
    const packageId = paymentIntent.metadata.packageId;

    if (!credits || !packageId) {
      return res.status(400).json({ error: 'Invalid payment metadata' });
    }

    const pkg = await storage.getCreditPackage(packageId);
    if (!pkg) {
      return res.status(404).json({ error: 'Package not found' });
    }

    // Add credits using atomic transaction (handles idempotency via unique constraint)
    try {
      await storage.addCreditsAtomic(userId, credits, `Purchased ${pkg.name}`, paymentIntent.id);
      import('../services/sip-credit-guard').then(({ reconnectAfterRecharge }) => reconnectAfterRecharge(userId)).catch(() => {});
      res.json({ success: true, credits });
    } catch (error: any) {
      // If duplicate payment ID, it's already processed
      if (error.message?.includes('unique') || error.message?.includes('duplicate')) {
        res.json({ success: true, alreadyProcessed: true });
      } else {
        throw error;
      }
    }
  } catch (error: any) {
    logger.error('Confirm payment error:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

// Create Stripe Checkout Session for Subscriptions or Credits
router.post('/create-checkout-session', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    // Check if Stripe is enabled
    const isEnabled = await isStripeEnabled();
    if (!isEnabled) {
      return res.status(400).json({ error: 'Stripe payments are not enabled' });
    }
    
    const stripe = await getStripeClient();
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe is not configured' });
    }
    
    const { type, planId, packageId, billingPeriod } = req.body;
    const userId = req.userId!;

    if (!type || !['subscription', 'credits'].includes(type)) {
      return res.status(400).json({ error: 'Invalid checkout type' });
    }

    // Get dynamic currency from settings
    const currencyConfig = await getStripeCurrency();

    // Get or create Stripe customer
    let user = await storage.getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Membership requirement for credit purchases - check both subscription table and user fields
    if (type === 'credits') {
      const hasMembership = await hasActiveMembership(userId);
      if (!hasMembership) {
        return res.status(403).json({ 
          error: 'Active Pro membership required to purchase credits. Please subscribe to a plan first.' 
        });
      }
    }

    // Get or create valid Stripe customer (handles invalid customer IDs)
    const stripeCustomerId = await getOrCreateValidStripeCustomer(stripe, userId, user);

    let sessionParams: Stripe.Checkout.SessionCreateParams = {
      customer: stripeCustomerId,
      mode: type === 'subscription' ? 'subscription' : 'payment',
      success_url: `${FRONTEND_URL}/app/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/app/billing?canceled=true`,
      metadata: {
        userId,
        type,
      },
    };

    if (type === 'subscription') {
      // Membership subscription
      if (!planId || !billingPeriod) {
        return res.status(400).json({ error: 'Plan ID and billing period required for subscriptions' });
      }

      const plan = await storage.getPlan(planId);
      if (!plan) {
        return res.status(404).json({ error: 'Plan not found' });
      }

      const priceId = billingPeriod === 'yearly' 
        ? plan.stripeYearlyPriceId 
        : plan.stripeMonthlyPriceId;

      if (!priceId) {
        return res.status(400).json({ error: 'Stripe price not configured for this plan' });
      }

      sessionParams.line_items = [{
        price: priceId,
        quantity: 1,
      }];
      sessionParams.metadata!.planId = planId;
      sessionParams.metadata!.billingPeriod = billingPeriod;
      
      // Set subscription metadata so webhook events can map back to user
      sessionParams.subscription_data = {
        metadata: {
          userId,
          planId,
        },
      };
    } else {
      // Credits purchase
      if (!packageId) {
        return res.status(400).json({ error: 'Package ID required for credit purchase' });
      }

      const pkg = await storage.getCreditPackage(packageId);
      if (!pkg) {
        return res.status(404).json({ error: 'Credit package not found' });
      }

      sessionParams.line_items = [{
        price_data: {
          currency: currencyConfig.currency.toLowerCase(),
          product_data: {
            name: pkg.name,
            description: pkg.description || `${pkg.credits} credits`,
          },
          unit_amount: Math.round(parseFloat(pkg.price.toString()) * 100), // Convert to cents
        },
        quantity: 1,
      }];
      sessionParams.metadata!.packageId = packageId;
      sessionParams.metadata!.credits = pkg.credits.toString();
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    res.json({ url: session.url });
  } catch (error: any) {
    logger.error('Stripe checkout session error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Upgrade/Downgrade Subscription (Change Plan)
router.post('/change-plan', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const stripe = await getStripeClient();
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe is not configured' });
    }
    
    const userId = req.userId!;
    const { newPlanId, billingPeriod } = req.body;

    if (!newPlanId) {
      return res.status(400).json({ error: 'New plan ID is required' });
    }

    // Get current subscription
    const userSub = await storage.getUserSubscription(userId);
    if (!userSub || !userSub.stripeSubscriptionId) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Get the new plan
    const newPlan = await storage.getPlan(newPlanId);
    if (!newPlan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    // Determine which price to use based on billing period
    const period = billingPeriod || userSub.billingPeriod || 'monthly';
    const newPriceId = period === 'yearly' 
      ? newPlan.stripeYearlyPriceId 
      : newPlan.stripeMonthlyPriceId;

    if (!newPriceId) {
      return res.status(400).json({ error: 'Stripe price not configured for this plan' });
    }

    // Retrieve current Stripe subscription
    const stripeSubscription = await stripe.subscriptions.retrieve(userSub.stripeSubscriptionId);
    
    // Get the current subscription item ID
    const currentItemId = stripeSubscription.items.data[0]?.id;
    if (!currentItemId) {
      return res.status(500).json({ error: 'Could not find subscription item' });
    }

    // Update subscription with new price
    // proration_behavior: 'none' means user switches immediately but pays new price next billing cycle
    const updatedSubscription = await stripe.subscriptions.update(userSub.stripeSubscriptionId, {
      items: [{
        id: currentItemId,
        price: newPriceId,
      }],
      proration_behavior: 'none', // No prorated charges - change takes effect at next renewal
      metadata: {
        userId,
        planId: newPlanId,
      },
    });

    // Update local database
    await storage.updateUserSubscription(userSub.id, {
      planId: newPlanId,
      billingPeriod: period,
    });

    // Update user's plan type
    await storage.updateUser(userId, {
      planType: newPlan.name,
    });

    logger.info(`✅ User ${userId} changed plan to ${newPlan.name} (${period})`);

    res.json({ 
      success: true,
      message: `Plan changed to ${newPlan.displayName}. New pricing takes effect at your next billing cycle.`,
      newPlan: {
        id: newPlan.id,
        name: newPlan.displayName,
        billingPeriod: period,
      },
      currentPeriodEnd: new Date((updatedSubscription as any).current_period_end * 1000),
    });
  } catch (error: any) {
    logger.error('Change plan error:', error);
    res.status(500).json({ error: 'Failed to change plan' });
  }
});

// Reactivate Cancelled Subscription (undo cancel_at_period_end)
router.post('/reactivate-subscription', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const stripe = await getStripeClient();
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe is not configured' });
    }
    
    const userId = req.userId!;
    
    // Get user's subscription
    const subscription = await storage.getUserSubscription(userId);
    if (!subscription || !subscription.stripeSubscriptionId) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    if (!subscription.cancelAtPeriodEnd) {
      return res.status(400).json({ error: 'Subscription is not set to cancel' });
    }

    // Reactivate by setting cancel_at_period_end to false
    await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });

    // Update local database
    await storage.updateUserSubscription(subscription.id, {
      cancelAtPeriodEnd: false,
    });

    logger.info(`✅ User ${userId} reactivated their subscription`);

    res.json({ 
      success: true,
      message: 'Subscription has been reactivated. You will continue to be billed normally.',
    });
  } catch (error: any) {
    logger.error('Reactivate subscription error:', error);
    res.status(500).json({ error: 'Failed to reactivate subscription' });
  }
});

// Cancel Subscription
router.post('/cancel-subscription', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const stripe = await getStripeClient();
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe is not configured' });
    }
    
    const userId = req.userId!;
    
    // Get user's subscription
    const subscription = await storage.getUserSubscription(userId);
    if (!subscription || !subscription.stripeSubscriptionId) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Set subscription to cancel at period end
    await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    // Update local database
    await storage.updateUserSubscription(subscription.id, {
      cancelAtPeriodEnd: true,
    });

    res.json({ 
      message: 'Subscription will be canceled at the end of the billing period',
      currentPeriodEnd: subscription.currentPeriodEnd 
    });
  } catch (error: any) {
    logger.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

export default router;
