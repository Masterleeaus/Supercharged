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
 * Health, version, diagnostic and public settings routes.
 * Split out of public-routes.ts; paths, methods, middleware and responses are unchanged.
 */
import { Router, Request, Response } from 'express';
import { RouteContext, AuthRequest } from './common';
import { users, calls, campaigns } from '@shared/schema';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export function createPublicSystemRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { db, storage, authenticateToken, requireRole } = ctx;

  // ============================================
  // HEALTH/DIAGNOSTIC ROUTES
  // ============================================

  router.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // ============================================
  // VERSION ROUTE
  // ============================================

  router.get("/api/system/version", (_req: Request, res: Response) => {
    try {
      const versionFile = path.join(process.cwd(), 'VERSION');
      let version = '5.4.5';

      if (fs.existsSync(versionFile)) {
        version = fs.readFileSync(versionFile, 'utf-8').trim();
      }

      res.json({ version });
    } catch (error: any) {
      logger.error('Failed to read version:', error.message);
      res.json({ version: '5.4.5' });
    }
  });


  router.get("/api/diagnostic", authenticateToken, requireRole('admin'), async (req: AuthRequest, res: Response) => {
    try {
      const requestingUser = await storage.getUser(req.userId!);
      if (requestingUser?.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const allUsers = await db.select().from(users);
      const admins = allUsers.filter(u => u.role === 'admin');
      const allCalls = await db.select().from(calls);
      const allCampaigns = await db.select().from(campaigns);

      res.json({
        environment: process.env.NODE_ENV || 'development',
        database: {
          totalUsers: allUsers.length,
          admins: admins.length,
          totalCalls: allCalls.length,
          totalCampaigns: allCampaigns.length,
        },
        secrets: {
          elevenlabs: !!process.env.ELEVENLABS_API_KEY,
          twilio_sid: !!process.env.TWILIO_ACCOUNT_SID,
          twilio_token: !!process.env.TWILIO_AUTH_TOKEN,
          stripe: !!process.env.STRIPE_SECRET_KEY,
        },
        message: 'System operational'
      });
    } catch (error: any) {
      logger.error('Diagnostic error:', error);
      res.status(500).json({ error: 'Diagnostic failed' });
    }
  });

  router.post("/api/diagnostic/grant-admin", (_req: Request, res: Response) => {
    res.status(410).json({ error: 'This endpoint has been permanently removed for security reasons' });
  });

  // ============================================
  // PUBLIC SETTINGS ROUTES
  // ============================================

  router.get("/api/settings/public", async (_req: Request, res: Response) => {
    try {
      const [
        phoneMonthlyCredits,
        lowCreditsThreshold,
        creditsPerMinute,
        otpExpiryMinutes,
        currencyDefault,
        currencySymbol,
        systemTimezone,
      ] = await Promise.all([
        storage.getGlobalSetting('phone_number_monthly_credits'),
        storage.getGlobalSetting('low_credits_threshold'),
        storage.getGlobalSetting('credits_per_minute'),
        storage.getGlobalSetting('otp_expiry_minutes'),
        storage.getGlobalSetting('currency_default'),
        storage.getGlobalSetting('currency_symbol'),
        storage.getGlobalSetting('system_timezone'),
      ]);

      res.json({
        phone_number_monthly_credits: typeof phoneMonthlyCredits?.value === 'number' ? phoneMonthlyCredits.value : 50,
        low_credits_threshold: typeof lowCreditsThreshold?.value === 'number' ? lowCreditsThreshold.value : 50,
        credits_per_minute: typeof creditsPerMinute?.value === 'number' ? creditsPerMinute.value : 1,
        otp_expiry_minutes: typeof otpExpiryMinutes?.value === 'number' ? otpExpiryMinutes.value : 5,
        currency_default: (currencyDefault?.value as string) || 'USD',
        currency_symbol: (currencySymbol?.value as string) || '$',
        system_timezone: (systemTimezone?.value as string) || 'UTC',
      });
    } catch (error) {
      logger.error('Error fetching public settings:', error);
      res.json({
        phone_number_monthly_credits: 50,
        low_credits_threshold: 50,
        credits_per_minute: 1,
        otp_expiry_minutes: 5,
        currency_default: 'USD',
        currency_symbol: '$',
        system_timezone: 'UTC',
      });
    }
  });

  router.get("/api/settings/llm-margin", async (_req: Request, res: Response) => {
    try {
      const setting = await storage.getGlobalSetting('llm_pricing_margin');
      const marginPercentage = setting?.value || 15;
      res.json({ llm_margin_percentage: parseFloat(marginPercentage as any) });
    } catch (error) {
      logger.error('Error fetching LLM margin:', error);
      res.json({ llm_margin_percentage: 15 });
    }
  });

  router.get("/api/settings/voice-engine", async (_req: Request, res: Response) => {
    try {
      const toBool = (value: any): boolean => {
        if (value === true || value === 'true') return true;
        if (value === false || value === 'false') return false;
        return Boolean(value);
      };

      const plivoEngineEnabled = await storage.getGlobalSetting('plivo_openai_engine_enabled');
      const twilioOpenaiEngineEnabled = await storage.getGlobalSetting('twilio_openai_engine_enabled');
      const twilioKycRequired = await storage.getGlobalSetting('twilio_kyc_required');
      const plivoKycRequired = await storage.getGlobalSetting('plivo_kyc_required');
      const defaultTtsModel = await storage.getGlobalSetting('default_tts_model');

      res.json({
        plivo_openai_engine_enabled: toBool(plivoEngineEnabled?.value) || false,
        twilio_openai_engine_enabled: toBool(twilioOpenaiEngineEnabled?.value) || false,
        twilio_kyc_required: toBool(twilioKycRequired?.value) ?? true,
        plivo_kyc_required: toBool(plivoKycRequired?.value) ?? true,
        default_tts_model: (defaultTtsModel?.value as string) || 'eleven_v3_conversational',
      });
    } catch (error) {
      logger.error('Error fetching voice engine settings:', error);
      res.json({
        plivo_openai_engine_enabled: false,
        twilio_openai_engine_enabled: false,
        twilio_kyc_required: true,
        plivo_kyc_required: true,
        default_tts_model: 'eleven_v3_conversational',
      });
    }
  });

  router.get("/api/settings/payment-gateway", async (_req: Request, res: Response) => {
    try {
      const toBool = (value: any): boolean => {
        if (value === true || value === 'true') return true;
        if (value === false || value === 'false') return false;
        return Boolean(value);
      };

      const currencySymbols: Record<string, string> = {
        'USD': '$', 'EUR': '€', 'GBP': '£', 'CAD': 'C$', 'AUD': 'A$',
        'JPY': '¥', 'INR': '₹', 'BRL': 'R$', 'MXN': '$', 'CHF': 'CHF',
        'NGN': '₦', 'GHS': '₵', 'ZAR': 'R', 'KES': 'KSh',
        'ARS': '$', 'CLP': '$', 'COP': '$', 'PEN': 'S/', 'UYU': '$'
      };

      const dbStripeSecretKey = await storage.getGlobalSetting('stripe_secret_key');
      const dbStripePublishableKey = await storage.getGlobalSetting('stripe_publishable_key');
      const envStripeSecretKey = process.env.STRIPE_SECRET_KEY;
      const envStripePublishableKey = process.env.VITE_STRIPE_PUBLIC_KEY;
      const stripeConfigured = !!((dbStripeSecretKey?.value && dbStripePublishableKey?.value) || (envStripeSecretKey && envStripePublishableKey));

      const dbRazorpayKeyId = await storage.getGlobalSetting('razorpay_key_id');
      const dbRazorpayKeySecret = await storage.getGlobalSetting('razorpay_key_secret');
      const razorpayConfigured = !!(dbRazorpayKeyId?.value && dbRazorpayKeySecret?.value);

      const dbPaypalClientId = await storage.getGlobalSetting('paypal_client_id');
      const dbPaypalClientSecret = await storage.getGlobalSetting('paypal_client_secret');
      const paypalConfigured = !!(dbPaypalClientId?.value && dbPaypalClientSecret?.value);

      const dbPaystackPublicKey = await storage.getGlobalSetting('paystack_public_key');
      const dbPaystackSecretKey = await storage.getGlobalSetting('paystack_secret_key');
      const paystackConfigured = !!(dbPaystackPublicKey?.value && dbPaystackSecretKey?.value);

      const dbMercadopagoAccessToken = await storage.getGlobalSetting('mercadopago_access_token');
      const dbMercadopagoPublicKey = await storage.getGlobalSetting('mercadopago_public_key');
      const mercadopagoConfigured = !!dbMercadopagoAccessToken?.value;

      const stripeEnabledSetting = await storage.getGlobalSetting('stripe_enabled');
      const razorpayEnabledSetting = await storage.getGlobalSetting('razorpay_enabled');
      const paypalEnabledSetting = await storage.getGlobalSetting('paypal_enabled');
      const paystackEnabledSetting = await storage.getGlobalSetting('paystack_enabled');
      const mercadopagoEnabledSetting = await storage.getGlobalSetting('mercadopago_enabled');

      const stripeEnabled = stripeConfigured && toBool(stripeEnabledSetting?.value) === true;
      const razorpayEnabled = razorpayConfigured && toBool(razorpayEnabledSetting?.value) === true;
      const paypalEnabled = paypalConfigured && toBool(paypalEnabledSetting?.value) === true;
      const paystackEnabled = paystackConfigured && toBool(paystackEnabledSetting?.value) === true;
      const mercadopagoEnabled = mercadopagoConfigured && toBool(mercadopagoEnabledSetting?.value) === true;

      const result: any = {
        stripeEnabled,
        razorpayEnabled,
        paypalEnabled,
        paystackEnabled,
        mercadopagoEnabled
      };

      if (stripeEnabled) {
        result.stripePublicKey = dbStripePublishableKey?.value || process.env.VITE_STRIPE_PUBLIC_KEY || null;

        const stripeCurrencySetting = await storage.getGlobalSetting('stripe_currency');
        const stripeCurrencyLockedSetting = await storage.getGlobalSetting('stripe_currency_locked');
        const stripeCurrency = (stripeCurrencySetting?.value as string) || 'USD';
        const stripeCurrencyLocked = toBool(stripeCurrencyLockedSetting?.value);

        result.stripeCurrency = stripeCurrency.toUpperCase();
        result.stripeCurrencySymbol = currencySymbols[stripeCurrency.toUpperCase()] || '$';
        result.stripeCurrencyLocked = stripeCurrencyLocked;
      }

      if (razorpayEnabled) {
        result.razorpayKeyId = dbRazorpayKeyId?.value || null;
        result.razorpayCurrency = 'INR';
        result.razorpayCurrencySymbol = '₹';
      }

      if (paypalEnabled) {
        result.paypalClientId = dbPaypalClientId?.value || null;
        const paypalCurrencySetting = await storage.getGlobalSetting('paypal_currency');
        const paypalModeSetting = await storage.getGlobalSetting('paypal_mode');
        const paypalCurrency = (paypalCurrencySetting?.value as string) || 'USD';
        result.paypalCurrency = paypalCurrency.toUpperCase();
        result.paypalCurrencySymbol = currencySymbols[paypalCurrency.toUpperCase()] || '$';
        result.paypalMode = (paypalModeSetting?.value as string) || 'sandbox';
      }

      if (paystackEnabled) {
        result.paystackPublicKey = dbPaystackPublicKey?.value || null;
        const paystackCurrencySetting = await storage.getGlobalSetting('paystack_currency');
        const paystackCurrency = (paystackCurrencySetting?.value as string) || 'NGN';
        result.paystackCurrency = paystackCurrency.toUpperCase();
        result.paystackCurrencySymbol = currencySymbols[paystackCurrency.toUpperCase()] || '₦';
        result.paystackCurrencies = ['NGN', 'GHS', 'ZAR', 'KES'];
        result.paystackDefaultCurrency = 'NGN';
      }

      if (mercadopagoEnabled) {
        result.mercadopagoPublicKey = dbMercadopagoPublicKey?.value || null;
        const mercadopagoCurrencySetting = await storage.getGlobalSetting('mercadopago_currency');
        const mercadopagoCurrency = (mercadopagoCurrencySetting?.value as string) || 'BRL';
        result.mercadopagoCurrency = mercadopagoCurrency.toUpperCase();
        result.mercadopagoCurrencySymbol = currencySymbols[mercadopagoCurrency.toUpperCase()] || 'R$';
        result.mercadopagoCurrencies = ['BRL', 'MXN', 'ARS', 'CLP', 'COP', 'PEN', 'UYU'];
      }

      res.json(result);
    } catch (error) {
      logger.error('Error fetching payment gateway config:', error);
      res.json({
        stripeEnabled: false,
        razorpayEnabled: false,
        paypalEnabled: false,
        paystackEnabled: false,
        mercadopagoEnabled: false,
        stripePublicKey: null
      });
    }
  });

  return router;
}
