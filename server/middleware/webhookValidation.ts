"use strict";
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

import { logger } from '../utils/logger';
import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { WebhookValidationError } from "../utils/errors";
import { getStripeClient } from "../services/stripe-service";
import { storage } from "../storage";

/**
 * Type for raw body request with buffer.
 */
export type RawBodyRequest = Request & {
  rawBody?: Buffer;
};

/**
 * Middleware to capture raw body for webhook signature verification.
 * Must be applied before body parsers for webhook routes.
 * 
 * @param {RawBodyRequest} req - Express request with rawBody property
 * @param {Response} _res - Express response object
 * @param {NextFunction} next - Express next function
 */
export function captureRawBody(
  req: RawBodyRequest,
  _res: Response,
  next: NextFunction
): void {
  if (req.headers["content-type"] === "application/json") {
    let data = "";
    req.setEncoding("utf8");
    
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    
    req.on("end", () => {
      req.rawBody = Buffer.from(data, "utf8");
      try {
        req.body = JSON.parse(data);
      } catch {
        req.body = {};
      }
      next();
    });
  } else {
    next();
  }
}

/**
 * Validates Stripe webhook signatures.
 * 
 * @param {RawBodyRequest} req - Express request with rawBody
 * @param {Response} res - Express response object
 * @param {NextFunction} next - Express next function
 */
export async function validateStripeWebhook(
  req: RawBodyRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const stripe = await getStripeClient();
    if (!stripe) {
      throw new WebhookValidationError("stripe", "Stripe not configured; webhook rejected");
    }

    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!sig) {
      throw new WebhookValidationError("stripe", "Missing Stripe signature header");
    }

    if (!webhookSecret) {
      throw new WebhookValidationError("stripe", "No Stripe webhook secret configured; webhook rejected");
    }

    const rawBody = req.rawBody?.toString() || JSON.stringify(req.body);

    try {
      const event = stripe.webhooks.constructEvent(rawBody, sig as string, webhookSecret);
      (req as any).stripeEvent = event;
      next();
    } catch (err: any) {
      throw new WebhookValidationError("stripe", `Signature verification failed: ${err.message}`);
    }
  } catch (error) {
    if (error instanceof WebhookValidationError) {
      logger.error(`[Stripe Webhook] Validation failed: ${error.message}`);
      res.status(401).json(error.toJSON());
    } else {
      next(error);
    }
  }
}

/**
 * Validates Razorpay webhook signatures using HMAC-SHA256.
 * 
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 * @param {NextFunction} next - Express next function
 */
export async function validateRazorpayWebhook(
  req: RawBodyRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const signature = req.headers["x-razorpay-signature"] as string;
    
    if (!signature) {
      throw new WebhookValidationError("razorpay", "Missing Razorpay signature header");
    }

    const webhookSecretSetting = await storage.getGlobalSetting("razorpay_webhook_secret");
    const webhookSecret = webhookSecretSetting?.value;

    if (!webhookSecret || typeof webhookSecret !== "string") {
      throw new WebhookValidationError("razorpay", "No Razorpay webhook secret configured; webhook rejected");
    }

    const rawBody = req.rawBody?.toString() || JSON.stringify(req.body);

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret as string)
      .update(rawBody)
      .digest("hex");

    if (expectedSignature !== signature) {
      throw new WebhookValidationError("razorpay", "Invalid webhook signature");
    }

    logger.info("[Razorpay Webhook] Signature verified successfully");
    next();
  } catch (error) {
    if (error instanceof WebhookValidationError) {
      logger.error(`[Razorpay Webhook] Validation failed: ${error.message}`);
      res.status(401).json(error.toJSON());
    } else {
      next(error);
    }
  }
}

/**
 * Validates Twilio webhook signatures.
 * Uses Twilio's built-in request validation.
 * 
 * Handles proxy environments (reverse proxies, load balancers) by:
 * 1. Using X-Forwarded-Proto header for correct protocol detection
 * 2. Using X-Forwarded-Host or configured domain for correct host
 * 
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 * @param {NextFunction} next - Express next function
 */
export async function validateTwilioWebhook(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const twilioSignature = req.headers["x-twilio-signature"] as string;
    
    if (!twilioSignature) {
      throw new WebhookValidationError("twilio", "Missing Twilio signature header");
    }

    const authTokenSetting = await storage.getGlobalSetting("twilio_auth_token");
    const authTokenValue = authTokenSetting?.value || process.env.TWILIO_AUTH_TOKEN;

    if (!authTokenValue || typeof authTokenValue !== "string") {
      throw new WebhookValidationError("twilio", "No Twilio auth token configured; webhook rejected");
    }

    const authToken: string = authTokenValue;
    const twilioModule = await import("twilio");
    
    // Handle both ESM (development) and CommonJS (production bundled) module structures
    // In ESM/tsx: twilioModule.default.validateRequest exists
    // In bundled production: twilioModule.validateRequest or twilioModule.default may differ
    const twilio = twilioModule.default || twilioModule;
    const validateRequest = typeof twilio.validateRequest === 'function' 
      ? twilio.validateRequest 
      : (twilioModule as any).validateRequest;
    
    if (typeof validateRequest !== 'function') {
      logger.error("[Twilio Webhook] validateRequest function not found in Twilio module");
      logger.error("[Twilio Webhook] Module keys:", Object.keys(twilioModule));
      logger.error("[Twilio Webhook] Default keys:", twilio ? Object.keys(twilio) : 'no default');
      throw new Error("Twilio validateRequest function not available");
    }
    
    // Construct the URL that Twilio used to calculate the signature
    // Behind proxies (reverse proxies, load balancers), req.protocol is 'http' but Twilio calls 'https'
    const protocol = (req.headers["x-forwarded-proto"] as string) || req.protocol;
    
    // Get the host - prefer X-Forwarded-Host, then configured domain, then req.get("host")
    const forwardedHost = req.headers["x-forwarded-host"] as string;
    let host: string;
    
    if (forwardedHost) {
      // Extract just the first host if multiple are provided (comma-separated)
      host = forwardedHost.split(',')[0].trim();
    } else {
      // Try to get from environment/configured domain
      const devDomain = process.env.DEV_DOMAIN;
      const appDomain = process.env.APP_DOMAIN;
      
      if (process.env.NODE_ENV !== 'production' && devDomain) {
        // Remove protocol prefix if present in DEV_DOMAIN
        host = devDomain.replace(/^https?:\/\//, '');
      } else if (appDomain) {
        // Remove protocol prefix if present in APP_DOMAIN
        host = appDomain.replace(/^https?:\/\//, '');
      } else {
        host = req.get("host") || 'localhost';
      }
    }
    
    const url = `${protocol}://${host}${req.originalUrl}`;
    
    logger.info(`[Twilio Webhook] Validating signature for URL: ${url}`);
    
    const isValid = validateRequest(
      authToken,
      twilioSignature,
      url,
      req.body
    );

    if (!isValid) {
      logger.error(`[Twilio Webhook] Signature mismatch. URL used: ${url}`);
      throw new WebhookValidationError("twilio", "Invalid Twilio webhook signature");
    }

    logger.info("[Twilio Webhook] Signature verified successfully");
    next();
  } catch (error) {
    if (error instanceof WebhookValidationError) {
      logger.error(`[Twilio Webhook] Validation failed: ${error.message}`);
      res.status(401).json(error.toJSON());
    } else {
      next(error);
    }
  }
}

/**
 * Generic HMAC-SHA256 webhook signature validator.
 * Can be configured for different providers.
 * 
 * @param {object} config - Configuration for the validator
 * @param {string} config.provider - Name of the webhook provider
 * @param {string} config.signatureHeader - HTTP header containing the signature
 * @param {string} config.secretKey - Key name in global settings for webhook secret
 * @param {string} config.secretEnvVar - Environment variable name for webhook secret
 * @returns {Function} Express middleware function
 */
export function createHmacWebhookValidator(config: {
  provider: string;
  signatureHeader: string;
  secretKey: string;
  secretEnvVar?: string;
}): (req: RawBodyRequest, res: Response, next: NextFunction) => Promise<void> {
  return async (req: RawBodyRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const signature = req.headers[config.signatureHeader.toLowerCase()] as string;
      
      if (!signature) {
        throw new WebhookValidationError(config.provider, "Missing webhook signature header");
      }

      const secretSetting = await storage.getGlobalSetting(config.secretKey);
      const secretValue = secretSetting?.value || (config.secretEnvVar ? process.env[config.secretEnvVar] : undefined);

      if (!secretValue || typeof secretValue !== "string") {
        throw new WebhookValidationError(config.provider, "No webhook secret configured; webhook rejected");
      }

      const secret: string = secretValue;
      const rawBody = req.rawBody?.toString() || JSON.stringify(req.body);

      const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");

      if (expectedSignature !== signature) {
        throw new WebhookValidationError(config.provider, "Invalid webhook signature");
      }

      logger.info(`[${config.provider} Webhook] Signature verified successfully`);
      next();
    } catch (error) {
      if (error instanceof WebhookValidationError) {
        logger.error(`[${config.provider} Webhook] Validation failed: ${error.message}`);
        res.status(401).json(error.toJSON());
      } else {
        next(error);
      }
    }
  };
}

/**
 * Logs webhook requests for debugging and auditing.
 * 
 * @param {string} provider - Name of the webhook provider
 * @returns {Function} Express middleware function
 */
export function logWebhookRequest(provider: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    logger.info(`[${provider} Webhook] Received request:`, {
      method: req.method,
      path: req.path,
      headers: {
        "content-type": req.headers["content-type"],
        "user-agent": req.headers["user-agent"]
      },
      timestamp: new Date().toISOString()
    });
    next();
  };
}
