'use strict';
/**
 * YooKassa Routes
 * Express router with all YooKassa payment endpoints
 */

import express, { Request, Response, Router } from 'express';
import crypto from 'crypto';
import { storage } from '../../../../storage';
import { authenticateToken, AuthRequest } from '../../../../middleware/auth';
import { hasActiveMembership, syncUserWithSubscription } from '../../../../services/membership-service';
import { recordWebhookReceived } from '../../webhook-helper';
import {
  getYookassaConfig,
  isYookassaEnabled,
  getYookassaCurrency,
  getSupportedCurrencies,
  initYookassaPayment,
} from './service';
import {
  handlePaymentSucceeded,
} from './handlers';
import { FRONTEND_URL } from '../../webhook-helper';
import { logger } from '../../../../utils/logger';

const router: Router = express.Router();

router.get('/config', async (_req: Request, res: Response) => {
  try {
    const config = await getYookassaConfig();
    const currencies = getSupportedCurrencies();
    res.json({
      ...config,
      supportedCurrencies: currencies,
    });
  } catch (error: any) {
    logger.error('Error fetching YooKassa config', error, 'YooKassa');
    res.status(500).json({ error: 'Failed to fetch YooKassa configuration' });
  }
});

router.post('/create-checkout-session', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const isEnabled = await isYookassaEnabled();
    if (!isEnabled) {
      return res.status(400).json({ error: 'YooKassa payments are not enabled' });
    }

    const { packageId, planId, billingPeriod = 'monthly' } = req.body;
    const userId = req.userId!;

    if (!packageId && !planId) {
      return res.status(400).json({ error: 'Package ID or Plan ID required' });
    }

    const user = await storage.getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currencyConfig = await getYookassaCurrency();
    let amount = 0;
    let description = '';
    const metadata: any = {
      userId,
    };

    if (packageId) {
      const hasMembership = await hasActiveMembership(userId);
      if (!hasMembership) {
        return res.status(403).json({
          error: 'Active Pro membership required to purchase credits. Please subscribe to a plan first.'
        });
      }

      const pkg = await storage.getCreditPackage(packageId);
      if (!pkg) {
        return res.status(404).json({ error: 'Credit package not found' });
      }

      const price = pkg.yookassaPrice ? parseFloat(pkg.yookassaPrice.toString()) : 0;
      if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({
          error: `Credit package does not have a price configured for YooKassa (${currencyConfig.currency}).`
        });
      }

      amount = price;
      description = `${pkg.name} - ${pkg.credits} Credits`;
      metadata.type = 'credits';
      metadata.packageId = packageId;
      metadata.credits = pkg.credits.toString();
    } else {
      const plan = await storage.getPlan(planId);
      if (!plan) {
        return res.status(404).json({ error: 'Plan not found' });
      }

      const priceField = billingPeriod === 'yearly' ? plan.yookassaYearlyPrice : plan.yookassaMonthlyPrice;
      const price = priceField ? parseFloat(priceField.toString()) : 0;
      if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({
          error: `Plan does not have a price configured for YooKassa (${currencyConfig.currency}) for ${billingPeriod} billing.`
        });
      }

      amount = price;
      description = `${plan.displayName} Subscription (${billingPeriod})`;
      metadata.type = 'subscription';
      metadata.planId = planId;
      metadata.billingPeriod = billingPeriod;
    }

    const redirectUrl = `${FRONTEND_URL}/dashboard?payment=success&gateway=yookassa`;
    
    // Pass metadata to the yookassa payment initiator
    const paymentResult = await initYookassaPayment({
      amount,
      currency: currencyConfig.currency,
      orderId: `order_${crypto.randomBytes(6).toString('hex')}`,
      redirectUrl,
      metadata,
    });

    res.json({
      success: true,
      url: paymentResult.authorizationUrl,
      paymentId: paymentResult.reference,
    });

  } catch (error: any) {
    logger.error('Failed to create checkout session', error, 'YooKassa');
    res.status(500).json({ error: error.message || 'Failed to create payment session' });
  }
});

router.post('/webhook', express.json(), async (req: Request, res: Response) => {
  try {
    const event = req.body;
    
    if (!event || !event.event) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    await recordWebhookReceived('yookassa');
    logger.info(`YooKassa Webhook received: ${event.event}`, undefined, 'YooKassa');

    if (event.event === 'payment.succeeded' && event.object) {
      const result = await handlePaymentSucceeded(event.object);
      if (result.success) {
        logger.info(`YooKassa Payment Succeeded handled: ${event.object.id}`, result, 'YooKassa');
      } else {
        logger.error(`YooKassa Payment Succeeded handle failure: ${event.object.id}`, new Error(result.error), 'YooKassa');
      }
    }

    // Always respond with 200 OK to YooKassa
    res.status(200).send('OK');
  } catch (error: any) {
    logger.error('Failed to process YooKassa webhook', error, 'YooKassa');
    res.status(500).send('Internal Server Error');
  }
});

export { router as yookassaRouter };
