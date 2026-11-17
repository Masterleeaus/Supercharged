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

import { Router, Request, Response } from 'express';
import { RouteContext, AuthRequest } from './common';
import { sql, eq } from 'drizzle-orm';
import { users, calls, campaigns, twilioCountries } from '@shared/schema';
import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';
import { runAllSeedsForInstaller } from '../seed-all';
import { applyEmbedCors } from '../middleware/embed-cors';
import { logger } from '../utils/logger';
import { checkInstallAllowed, INSTALL_SETUP_TOKEN_HEADER } from './installer-guard';
import { PRODUCT_NAME } from '../../shared/brand.ts';
import { createPublicSystemRoutes } from './public-system-routes';
import { createPublicMarketingRoutes } from './public-marketing-routes';

/**
 * Creates public routes for unauthenticated endpoints.
 * Includes installer, health, branding, SEO, public stats, contact form, and more.
 */
export function createPublicRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { db, storage } = ctx;

  async function getAppNameFallback(): Promise<string> {
    try {
      const setting = await storage.getGlobalSetting('app_name');
      return (setting?.value as string) || PRODUCT_NAME;
    } catch {
      return PRODUCT_NAME;
    }
  }

  /**
   * Check if installation is complete by checking for any users in the database.
   */
  async function isInstalled(): Promise<boolean> {
    try {
      const userCount = await db.select({ count: sql<number>`count(*)::int` }).from(users);
      return userCount[0]?.count > 0;
    } catch {
      return false;
    }
  }

  // ============================================
  // INSTALLER ROUTES
  // ============================================

  router.get("/api/installer/status", async (_req: Request, res: Response) => {
    try {
      const installed = await isInstalled();
      res.json({ installed });
    } catch (error: any) {
      res.status(500).json({ message: "Failed to check installation status" });
    }
  });

  // ============================================
  // COMBINED INIT ENDPOINT (Performance Optimization)
  // ============================================
  // Returns branding, installer status, and version in one request
  // Reduces initial page load from 5+ API calls to 1
  router.get("/api/init", async (req: Request, res: Response) => {
    // Cache for 2 minutes - reduces server load on repeat visits
    res.setHeader('Cache-Control', 'public, max-age=120');
    // Cross-origin only for allowlisted embed domains; Vary: Origin is set by the helper
    await applyEmbedCors(db, req, res);

    // Get version from VERSION file (same source as /api/system/version)
    let version = '5.4.5';
    try {
      const versionFile = path.join(process.cwd(), 'VERSION');
      if (fs.existsSync(versionFile)) {
        version = fs.readFileSync(versionFile, 'utf-8').trim();
      }
    } catch { /* use default */ }

    try {
      // Fetch all data in parallel for speed
      const [installed, brandingSettings, seoSettings] = await Promise.all([
        isInstalled(),
        (async () => {
          const brandingKeys = ['app_name', 'app_tagline', 'logo_url', 'logo_url_light', 'logo_url_dark', 'favicon_url'];
          const branding: Record<string, any> = {};
          for (const key of brandingKeys) {
            const setting = await storage.getGlobalSetting(key);
            if (setting) branding[key] = setting.value;
          }
          return branding;
        })(),
        storage.getSeoSettings().catch(() => null)
      ]);

      res.json({
        success: true,
        installed,
        branding: {
          app_name: brandingSettings.app_name || PRODUCT_NAME,
          app_tagline: brandingSettings.app_tagline || '',
          logo_url: brandingSettings.logo_url || null,
          logo_url_light: brandingSettings.logo_url_light || null,
          logo_url_dark: brandingSettings.logo_url_dark || null,
          favicon_url: brandingSettings.favicon_url || null,
        },
        seo: seoSettings ? {
          defaultTitle: seoSettings.defaultTitle,
          defaultDescription: seoSettings.defaultDescription,
        } : null,
        version
      });
    } catch (error: any) {
      logger.error('Error in /api/init:', error);
      res.json({
        success: false,
        installed: false,
        branding: { app_name: PRODUCT_NAME, app_tagline: '', logo_url: null, favicon_url: null },
        seo: null,
        version
      });
    }
  });

  router.get("/api/installer/check", async (_req: Request, res: Response) => {
    try {
      const installed = await isInstalled();
      if (installed) {
        return res.status(403).json({ message: "Application is already installed" });
      }

      const checks = [];

      const nodeVersion = process.version;
      const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0], 10);
      checks.push({
        name: "Node.js Version",
        status: majorVersion >= 18 ? "success" : "error",
        message: majorVersion >= 18 ? `Node.js ${nodeVersion} (Required: 18+)` : `Node.js ${nodeVersion} is too old. Upgrade to 18+`
      });

      try {
        await db.execute(sql`SELECT 1`);
        checks.push({
          name: "Database Connection",
          status: "success",
          message: "PostgreSQL connection successful"
        });
      } catch (error: any) {
        checks.push({
          name: "Database Connection",
          status: "error",
          message: "Database connection failed"
        });
      }

      const requiredEnvVars = ['DATABASE_URL', 'SESSION_SECRET'];
      const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
      checks.push({
        name: "Environment Variables",
        status: missingEnvVars.length === 0 ? "success" : "error",
        message: missingEnvVars.length === 0 ? "Required variables set" : `Missing: ${missingEnvVars.join(', ')}`
      });

      const optionalKeys = [
        { name: 'STRIPE_SECRET_KEY', label: 'Stripe' },
        { name: 'TWILIO_ACCOUNT_SID', label: 'Twilio' },
        { name: 'ELEVENLABS_API_KEY', label: 'ElevenLabs' }
      ];
      const missingOptional = optionalKeys.filter(k => !process.env[k.name]);
      checks.push({
        name: "API Keys",
        status: missingOptional.length === 0 ? "success" : "warning",
        message: missingOptional.length === 0 ? "All optional API keys configured" : `Configure later in Settings: ${missingOptional.map(k => k.label).join(', ')}`
      });

      const hasErrors = checks.some(c => c.status === "error");
      res.json({ checks, canInstall: !hasErrors });
    } catch (error: any) {
      res.status(500).json({ message: "Failed to run system checks" });
    }
  });

  router.post("/api/installer/install", async (req: Request, res: Response) => {
    try {
      const denial = await checkInstallAllowed({
        presentedToken: req.get(INSTALL_SETUP_TOKEN_HEADER),
        isInstalled,
      });
      if (denial) {
        logger.warn(`Installer request refused: ${denial.message}`);
        return res.status(denial.status).json({ message: denial.message });
      }

      const { adminEmail, adminPassword, companyName } = req.body;

      if (!adminEmail || !adminPassword || !companyName) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      if (adminPassword.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(adminEmail)) {
        return res.status(400).json({ message: "Invalid email address" });
      }

      logger.info("╔════════════════════════════════════════════════════════════╗");
      logger.info("║           🚀 Installing Platform                           ║");
      logger.info("╚════════════════════════════════════════════════════════════╝");

      logger.info("\n📦 Step 1: Seeding database with required data...");
      const seedResult = await runAllSeedsForInstaller();

      if (!seedResult.success) {
        logger.error("❌ Seeding failed:", seedResult.error);
        return res.status(500).json({
          message: "Installation failed during database seeding",
          error: seedResult.error
        });
      }

      logger.info("✅ Database seeding complete!");
      logger.info(`   Seeded: ${Object.entries(seedResult.summary).map(([k, v]) => `${k}: ${v}`).join(', ')}`);

      logger.info("\n👤 Step 2: Creating admin account...");
      const hashedPassword = await bcrypt.hash(adminPassword, 10);

      const [admin] = await db.insert(users).values({
        email: adminEmail,
        password: hashedPassword,
        name: companyName + " Admin",
        role: "admin",
        planType: "pro",
        credits: 10000,
        isActive: true,
      }).returning();

      logger.info(`✅ Admin created: ${admin.id}`);
      logger.info(`   Role: ${admin.role}`);
      logger.info(`   Plan: ${admin.planType}`);
      logger.info(`   Credits: ${admin.credits}`);

      logger.info("\n⚙️  Step 3: Configuring platform settings...");
      const settingsToCreate = [
        { key: 'company_name', value: companyName, description: 'Company name displayed across the platform' },
        { key: 'app_name', value: companyName, description: 'Initial app branding from installer company name' },
        { key: 'support_email', value: adminEmail, description: 'Support email for customer inquiries' },
      ];

      for (const setting of settingsToCreate) {
        try {
          await db.execute(sql`
            INSERT INTO global_settings (key, value, description, updated_at)
            VALUES (${setting.key}, ${JSON.stringify(setting.value)}::jsonb, ${setting.description}, NOW())
            ON CONFLICT (key) DO UPDATE 
            SET value = EXCLUDED.value, updated_at = NOW()
          `);
          logger.info(`   ✅ Set ${setting.key}`);
        } catch (error: any) {
          logger.warn(`   ⚠️ Failed to set ${setting.key}: ${error.message}`);
        }
      }
      logger.info("✅ Platform settings configured!");

      logger.info("\n╔════════════════════════════════════════════════════════════╗");
      logger.info("║           🎉 Installation Complete!                        ║");
      logger.info("╚════════════════════════════════════════════════════════════╝");
      logger.info(`\n📋 Installation Summary:`);
      logger.info(`   Admin ID: ${admin.id}`);
      logger.info(`   Company: ${companyName}`);
      logger.info(`   Database Seeds: ${Object.keys(seedResult.summary).length} categories`);
      logger.info(`   Ready to use!\n`);

      res.json({
        success: true,
        message: "Platform installed successfully!",
        admin: {
          email: admin.email,
          password: adminPassword,
          id: admin.id
        },
        seeds: seedResult.summary
      });
    } catch (error: any) {
      logger.error("Installation error:", error);
      res.status(500).json({ message: "Installation failed" });
    }
  });

  router.use(createPublicSystemRoutes(ctx));

  // ============================================
  // BRANDING ROUTE
  // ============================================

  // OPTIONS handler for CORS preflight requests (widget embedding)
  router.options("/api/branding", async (req: Request, res: Response) => {
    if (await applyEmbedCors(db, req, res)) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    res.sendStatus(200);
  });

  router.get("/api/branding", async (req: Request, res: Response) => {
    // Cross-origin only for allowlisted embed domains; Vary: Origin is set by the helper
    if (await applyEmbedCors(db, req, res)) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    try {
      const brandingKeys = ['app_name', 'app_tagline', 'logo_url', 'logo_url_light', 'logo_url_dark', 'favicon_url', 'branding_updated_at', 'admin_email', 'app_location', 'social_twitter_url', 'social_linkedin_url', 'social_github_url', 'theme_primary', 'theme_primary_foreground', 'theme_accent', 'theme_background', 'theme_sidebar', 'theme_website_accent', 'theme_website_foreground'];
      const branding: Record<string, any> = {
        app_name: PRODUCT_NAME,
        app_tagline: '',
        logo_url: null,
        logo_url_light: null,
        logo_url_dark: null,
        favicon_url: null,
        branding_updated_at: null,
        admin_email: null,
        app_location: null,
        social_twitter_url: null,
        social_linkedin_url: null,
        social_github_url: null,
        theme_primary: null,
        theme_primary_foreground: null,
        theme_accent: null,
        theme_background: null,
        theme_sidebar: null,
        theme_website_accent: null,
        theme_website_foreground: null
      };

      for (const key of brandingKeys) {
        const setting = await storage.getGlobalSetting(key);
        if (setting) {
          // A blank stored name must not override the product identity.
          if (key === 'app_name' && (typeof setting.value !== 'string' || !setting.value.trim())) continue;
          branding[key] = setting.value;
        }
      }

      res.setHeader('Cache-Control', 'no-store'); // Reflect admin branding updates without a five-minute stale response.
      res.json(branding);
    } catch (error) {
      logger.error('Error fetching branding:', error);
      res.json({
        app_name: PRODUCT_NAME,
        app_tagline: '',
        logo_url: null,
        favicon_url: null,
        social_twitter_url: null,
        social_linkedin_url: null,
        social_github_url: null
      });
    }
  });

  // ============================================
  // SEO ROUTES
  // ============================================

  const SEO_DEFAULT_URLS: Array<{ url: string; changefreq: string; priority: number; lastmod?: string }> = [
    { url: '/', changefreq: 'weekly', priority: 1.0 },
    { url: '/pricing', changefreq: 'weekly', priority: 0.9 },
    { url: '/features', changefreq: 'weekly', priority: 0.9 },
    { url: '/use-cases', changefreq: 'weekly', priority: 0.8 },
    { url: '/integrations', changefreq: 'weekly', priority: 0.8 },
    { url: '/blog', changefreq: 'daily', priority: 0.7 },
    { url: '/contact', changefreq: 'monthly', priority: 0.6 },
    { url: '/about', changefreq: 'monthly', priority: 0.5 },
    { url: '/privacy', changefreq: 'yearly', priority: 0.2 },
    { url: '/terms', changefreq: 'yearly', priority: 0.2 },
  ];

  function escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function getCanonicalBaseUrl(seoSettings: any, req?: Request): string {
    const canonicalUrl = seoSettings?.canonicalBaseUrl
      || process.env.CANONICAL_BASE_URL
      || '';

    if (canonicalUrl) {
      return canonicalUrl.replace(/\/+$/, '');
    }

    if (req) {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.get('host');
      if (host) {
        return `${proto}://${host}`.replace(/\/+$/, '');
      }
    }

    return '';
  }

  router.get("/sitemap.xml", async (req: Request, res: Response) => {
    try {
      const seoSettings = await storage.getSeoSettings();

      if (seoSettings && seoSettings.sitemapEnabled === false) {
        return res.status(404).send('Not Found');
      }

      const baseUrl = getCanonicalBaseUrl(seoSettings, req);

      const rawCustomUrls = (seoSettings?.sitemapUrls as any[]) || [];
      const customUrls = rawCustomUrls.map((item: any) => {
        if (typeof item === 'string') {
          return { url: item, changefreq: 'weekly', priority: 0.5 };
        }
        return item;
      });

      const allUrls = [...SEO_DEFAULT_URLS];
      for (const customUrl of customUrls) {
        const existingIndex = allUrls.findIndex(u => u.url === customUrl.url);
        if (existingIndex >= 0) {
          allUrls[existingIndex] = customUrl;
        } else {
          allUrls.push(customUrl);
        }
      }

      const today = new Date().toISOString().split('T')[0];
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allUrls.map(u => {
        const changefreq = u.changefreq || 'weekly';
        const priority = typeof u.priority === 'number' ? u.priority.toFixed(1) : '0.5';
        const fullUrl = u.url.startsWith('http') ? u.url : `${baseUrl}${u.url}`;
        return `  <url>
    <loc>${escapeXml(fullUrl)}</loc>
    <lastmod>${u.lastmod || today}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
      }).join('\n')}
</urlset>`;

      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(xml);
    } catch (error) {
      logger.error('Error generating sitemap:', error);
      res.status(500).send('Error generating sitemap');
    }
  });

  router.get("/robots.txt", async (req: Request, res: Response) => {
    try {
      const seoSettings = await storage.getSeoSettings();

      if (seoSettings && seoSettings.robotsEnabled === false) {
        return res.status(404).send('Not Found');
      }

      const baseUrl = getCanonicalBaseUrl(seoSettings, req);

      const defaultRules = [
        {
          userAgent: '*',
          allow: ['/', '/pricing', '/features', '/use-cases', '/integrations', '/blog', '/contact', '/about', '/privacy', '/terms'],
          disallow: ['/app/', '/admin/', '/api/']
        }
      ];

      const rules = (seoSettings?.robotsRules as any[]) || defaultRules;
      const crawlDelay = seoSettings?.robotsCrawlDelay || 0;

      let content = '';
      for (const rule of rules) {
        content += `User-agent: ${rule.userAgent}\n`;
        for (const allow of (rule.allow || [])) {
          content += `Allow: ${allow}\n`;
        }
        for (const disallow of (rule.disallow || [])) {
          content += `Disallow: ${disallow}\n`;
        }
        if (crawlDelay > 0) {
          content += `Crawl-delay: ${crawlDelay}\n`;
        }
        content += '\n';
      }

      content += `Sitemap: ${baseUrl}/sitemap.xml\n`;

      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(content);
    } catch (error) {
      logger.error('Error generating robots.txt:', error);
      const fallbackBaseUrl = getCanonicalBaseUrl(null, req);
      res.setHeader('Content-Type', 'text/plain');
      res.send(`User-agent: *\nAllow: /\nDisallow: /app/\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${fallbackBaseUrl}/sitemap.xml\n`);
    }
  });

  router.use(createPublicMarketingRoutes(ctx));

  return router;
}
