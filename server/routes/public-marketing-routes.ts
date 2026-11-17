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
 * Public stats, SEO/analytics, contact form and Twilio country routes.
 * Split out of public-routes.ts; paths, methods, middleware and responses are unchanged.
 */
import { Router, Request, Response } from 'express';
import { RouteContext } from './common';
import { eq } from 'drizzle-orm';
import { users, calls, campaigns, twilioCountries } from '@shared/schema';
import { logger } from '../utils/logger';
import { PRODUCT_NAME } from '../../shared/brand.ts';

export function createPublicMarketingRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { db, storage, emailService, authRateLimiter } = ctx;

  // ============================================
  // PUBLIC STATS/DEMO ROUTES
  // ============================================

  router.get("/api/public/stats", async (_req: Request, res: Response) => {
    try {
      const allUsers = await db.select().from(users);
      const allCalls = await db.select().from(calls);
      const allCampaigns = await db.select().from(campaigns);

      const totalUsers = allUsers.length;
      const totalCalls = allCalls.length;
      const completedCalls = allCalls.filter(c => c.status === 'completed').length;
      const completedCampaigns = allCampaigns.filter(c => c.status === 'completed').length;
      const qualifiedLeads = allCalls.filter(c => c.classification === 'hot' || c.classification === 'warm').length;

      const avgCallDuration = 2.5;
      const timeSavedHours = Math.round((completedCalls * avgCallDuration) / 60);
      const profitMultiplier = 45;
      const estimatedProfit = qualifiedLeads * profitMultiplier;

      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({
        totalUsers,
        totalCalls,
        completedCampaigns,
        qualifiedLeads,
        timeSavedHours,
        estimatedProfit
      });
    } catch (error) {
      logger.error('Error fetching public stats:', error);
      res.json({
        totalUsers: 2500,
        totalCalls: 125000,
        completedCampaigns: 8500,
        qualifiedLeads: 45000,
        timeSavedHours: 12500,
        estimatedProfit: 2025000
      });
    }
  });

  // ============================================
  // PUBLIC SEO/ANALYTICS ROUTES
  // ============================================

  router.get("/api/public/seo", async (_req: Request, res: Response) => {
    try {
      const seoSettings = await storage.getSeoSettings();

      if (!seoSettings) {
        return res.json({
          defaultTitle: null,
          defaultDescription: null,
          defaultKeywords: [],
          defaultOgImage: null,
          canonicalBaseUrl: null,
          twitterHandle: null,
          facebookAppId: null,
          googleVerification: null,
          bingVerification: null,
          structuredDataOrg: null,
          structuredDataFaq: null,
          structuredDataProduct: null
        });
      }

      const structuredData = seoSettings.structuredData;
      let structuredDataOrg = null;

      if (structuredData && seoSettings.structuredDataEnabled) {
        structuredDataOrg = {
          name: structuredData.organizationName || null,
          url: structuredData.organizationUrl || null,
          logo: structuredData.organizationLogo || null,
          description: structuredData.organizationDescription || null,
          contactPoint: (structuredData.contactEmail || structuredData.contactPhone) ? {
            email: structuredData.contactEmail || undefined,
            telephone: structuredData.contactPhone || undefined,
            contactType: "customer service"
          } : undefined,
          sameAs: structuredData.socialProfiles || []
        };
      }

      let structuredDataFaq = null;
      const faqData = seoSettings.structuredDataFaq as any[];
      if (faqData && faqData.length > 0 && seoSettings.structuredDataFaqEnabled) {
        structuredDataFaq = faqData.map((item: any) => ({
          question: item.question,
          answer: item.answer
        }));
      }

      let structuredDataProduct = null;
      const productData = seoSettings.structuredDataProduct as any;
      if (productData && seoSettings.structuredDataProductEnabled) {
        structuredDataProduct = {
          name: productData.name || null,
          description: productData.description || null,
          image: productData.image || null,
          brand: productData.brand || null,
          sku: productData.sku || null,
          price: productData.price || null,
          priceCurrency: productData.priceCurrency || 'USD',
          availability: productData.availability || 'InStock',
          url: productData.url || null,
          ratingValue: productData.ratingValue || null,
          ratingCount: productData.ratingCount || null
        };
      }

      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({
        defaultTitle: seoSettings.defaultTitle,
        defaultDescription: seoSettings.defaultDescription,
        defaultKeywords: seoSettings.defaultKeywords || [],
        defaultOgImage: seoSettings.defaultOgImage,
        canonicalBaseUrl: seoSettings.canonicalBaseUrl,
        twitterHandle: seoSettings.twitterHandle,
        facebookAppId: seoSettings.facebookAppId,
        googleVerification: seoSettings.googleVerification,
        bingVerification: seoSettings.bingVerification,
        structuredDataOrg: structuredDataOrg,
        structuredDataFaq: structuredDataFaq,
        structuredDataProduct: structuredDataProduct
      });
    } catch (error) {
      logger.error('Error fetching public SEO settings:', error);
      res.status(500).json({ error: 'Failed to fetch SEO settings' });
    }
  });

  router.get("/api/public/analytics-scripts", async (_req: Request, res: Response) => {
    try {
      const scripts = await storage.getEnabledAnalyticsScripts();

      const sortedScripts = scripts
        .sort((a, b) => (b.loadPriority || 0) - (a.loadPriority || 0))
        .map(script => ({
          id: script.id,
          name: script.name,
          type: script.type,
          code: script.code,
          headCode: script.headCode,
          bodyCode: script.bodyCode,
          placement: script.placement,
          loadPriority: script.loadPriority,
          async: script.async,
          defer: script.defer,
          hideOnInternalPages: script.hideOnInternalPages,
          updatedAt: script.updatedAt,
        }));

      res.setHeader('Cache-Control', 'no-cache');
      res.json(sortedScripts);
    } catch (error) {
      logger.error('Error fetching public analytics scripts:', error);
      res.status(500).json({ error: 'Failed to fetch analytics scripts' });
    }
  });

  // ============================================
  // CONTACT FORM ROUTE
  // ============================================

  router.post("/api/contact", authRateLimiter, async (req: Request, res: Response) => {
    try {
      const { z } = await import('zod');

      const contactSchema = z.object({
        name: z.string().min(2, "Name must be at least 2 characters"),
        email: z.string().email("Invalid email address"),
        company: z.string().optional(),
        phone: z.string().optional(),
        message: z.string().min(10, "Message must be at least 10 characters"),
      });

      const validationResult = contactSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          error: validationResult.error.issues[0]?.message || "Invalid form data"
        });
      }

      const { name, email, company, phone, message } = validationResult.data;

      const adminEmailSetting = await storage.getGlobalSetting('admin_email');
      const smtpFromEmail = await storage.getGlobalSetting('smtp_from_email');
      const adminEmail = (adminEmailSetting?.value as string) || (smtpFromEmail?.value as string) || process.env.SMTP_USER;

      const appNameSetting = await storage.getGlobalSetting('app_name');
      const appName = (appNameSetting?.value as string) || PRODUCT_NAME;

      if (!adminEmail) {
        logger.error('No admin email configured for contact form');
        return res.status(500).json({ error: "Contact form not configured. Please try again later." });
      }

      if (!emailService.isEnabled()) {
        logger.error('Email service is not configured');
        return res.status(500).json({ error: "Email service not configured. Please contact the administrator." });
      }

      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #f59e0b, #ea580c); color: white; padding: 24px; border-radius: 8px 8px 0 0; }
            .content { background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; }
            .field { margin-bottom: 16px; }
            .label { font-weight: 600; color: #6b7280; font-size: 12px; text-transform: uppercase; }
            .value { margin-top: 4px; font-size: 15px; }
            .message-box { background: white; padding: 16px; border-radius: 8px; border: 1px solid #e5e7eb; margin-top: 8px; white-space: pre-wrap; }
            .footer { text-align: center; padding: 16px; font-size: 12px; color: #9ca3af; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2 style="margin: 0;">${appName} - New Contact Form Submission</h2>
            </div>
            <div class="content">
              <div class="field">
                <div class="label">Name</div>
                <div class="value">${name}</div>
              </div>
              <div class="field">
                <div class="label">Email</div>
                <div class="value"><a href="mailto:${email}">${email}</a></div>
              </div>
              ${company ? `<div class="field">
                <div class="label">Company</div>
                <div class="value">${company}</div>
              </div>` : ''}
              ${phone ? `<div class="field">
                <div class="label">Phone</div>
                <div class="value"><a href="tel:${phone}">${phone}</a></div>
              </div>` : ''}
              <div class="field">
                <div class="label">Message</div>
                <div class="message-box">${message}</div>
              </div>
            </div>
            <div class="footer">
              Sent from ${appName} Contact Form
            </div>
          </div>
        </body>
        </html>
      `;

      const subject = `[${appName}] New Contact: ${name}${company ? ` from ${company}` : ''}`;
      const textContent = `New contact form submission:\n\nName: ${name}\nEmail: ${email}\n${company ? `Company: ${company}\n` : ''}${phone ? `Phone: ${phone}\n` : ''}Message:\n${message}`;

      const result = await emailService.sendEmail(adminEmail, subject, htmlContent, undefined, {
        replyTo: email,
        text: textContent
      });

      if (!result.success) {
        logger.error(`Contact form email failed: ${result.error}`);
        return res.status(500).json({ error: "Failed to send message. Please try again later." });
      }

      logger.info(`✉️ [Contact] Form submission sent to admin`);

      res.json({ success: true, message: "Thank you! We'll get back to you soon." });
    } catch (error: any) {
      logger.error('Contact form error:', error);
      res.status(500).json({ error: "Failed to send message. Please try again later." });
    }
  });

  // ============================================
  // TWILIO COUNTRIES ROUTE
  // ============================================

  router.get("/api/twilio-countries", async (_req: Request, res: Response) => {
    try {
      const countries = await db
        .select()
        .from(twilioCountries)
        .where(eq(twilioCountries.isActive, true))
        .orderBy(twilioCountries.name);

      res.json(countries);
    } catch (error) {
      logger.error('Error fetching Twilio countries:', error);
      res.status(500).json({ error: 'Failed to fetch countries' });
    }
  });

  return router;
}
