/**
 * ============================================================
 * DEMO MODE - INTERNAL USE ONLY
 * This folder is excluded from distribution packages.
 * 
 * Enable by setting DEMO_MODE=true in environment variables.
 * 
 * IMPORTANT: On hosting platforms (Heroku, DigitalOcean, etc.), 
 * environment variables set in the platform's dashboard/Secrets
 * will OVERRIDE values in the .env file. Make sure to:
 * 1. Update DEMO_MODE in the platform's environment settings
 * 2. Restart the application after changing the value
 * ============================================================
 */
import type { Express, Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { authenticateToken, type AuthRequest } from '../middleware/auth';
import jwt from 'jsonwebtoken';

export interface DemoModeConfig {
  blockAdminMutations: boolean;
  hideSensitiveData: boolean;
  showDemoBanner: boolean;
  maxCallsPerUserPerDay: number;
}

const config: DemoModeConfig = {
  blockAdminMutations: true,
  hideSensitiveData: true,
  showDemoBanner: true,
  maxCallsPerUserPerDay: 3,
};

const ALLOWED_MUTATION_PATHS = [
  '/api/admin/analytics',
  '/api/admin/dashboard',
  '/api/admin/test-connection',
  '/api/admin/elevenlabs-pool',
  '/api/auth/',
  '/api/public/',
  '/api/agents',
  '/api/campaigns',
  '/api/calls',
  '/api/flows',
  '/api/contacts',
  '/api/incoming-connections',
  '/api/knowledge-base',
  '/api/crm',
  '/api/user',
];

const BLOCKED_MUTATION_PREFIXES = [
  '/api/admin',
  '/api/sip/admin',
  '/api/team/admin',
];

const SENSITIVE_DATA_PREFIXES = [
  '/api/admin/',
  '/api/user/api-keys',
  '/api/settings',
  '/api/sip/',
  '/api/team/',
];

function isDemoModeEnabled(): boolean {
  return process.env.DEMO_MODE === 'true';
}

function getDemoEmails(): string[] {
  const envEmails = process.env.DEMO_EMAILS;
  if (!envEmails) return [];
  return envEmails.split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
}

async function isRequestDemoUser(req: Request): Promise<boolean> {
  const demoEmails = getDemoEmails();
  // If DEMO_MODE=true but DEMO_EMAILS is empty, fall back to global application to all users
  if (demoEmails.length === 0) {
    return true;
  }

  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) {
    return false;
  }

  try {
    const JWT_SECRET = process.env.JWT_SECRET || "insecure-dev-secret-CHANGE-ME";
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    if (decoded.userId) {
      const userResult = await db.execute(sql`SELECT email FROM users WHERE id = ${decoded.userId} LIMIT 1`);
      const email = (userResult.rows[0]?.email as string)?.toLowerCase();
      if (email && demoEmails.includes(email)) {
        return true;
      }
    }
  } catch (error) {
    // If token verification fails, let the auth middleware handle the 401/403
  }

  return false;
}

async function blockAdminMutationsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!isDemoModeEnabled() || !config.blockAdminMutations) {
    return next();
  }

  const method = req.method.toUpperCase();
  const path = req.path;

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const isBlockedPath = BLOCKED_MUTATION_PREFIXES.some(prefix => path.startsWith(prefix));
    const isAllowedPath = ALLOWED_MUTATION_PATHS.some(allowed => path.startsWith(allowed));

    if (isBlockedPath && !isAllowedPath) {
      const isDemoUser = await isRequestDemoUser(req);
      if (isDemoUser) {
        console.log(`[Demo Mode] Blocked ${method} ${path}`);
        return res.status(403).json({
          success: false,
          error: 'Demo Mode Active',
          message: 'Save operations are disabled in demo mode. This feature works in production.',
          demoMode: true,
        });
      }
    }
  }

  next();
}

async function filterSensitiveDataMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!isDemoModeEnabled() || !config.hideSensitiveData) {
    return next();
  }

  const path = req.path;
  const method = req.method.toUpperCase();

  if (method !== 'GET') {
    return next();
  }

  const isSensitivePath = SENSITIVE_DATA_PREFIXES.some(sensitive => path.startsWith(sensitive));

  if (isSensitivePath) {
    const isDemoUser = await isRequestDemoUser(req);
    if (isDemoUser) {
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      res.json = function (data: any) {
        try {
          const filtered = deepFilterSensitiveData(data);
          return originalJson(filtered);
        } catch (error) {
          console.error('[Demo Mode] Error filtering JSON response:', error);
          return originalJson(data);
        }
      };

      res.send = function (data: any) {
        try {
          if (typeof data === 'object' && data !== null) {
            const filtered = deepFilterSensitiveData(data);
            return originalSend(filtered);
          }
          if (typeof data === 'string') {
            try {
              const parsed = JSON.parse(data);
              const filtered = deepFilterSensitiveData(parsed);
              return originalSend(JSON.stringify(filtered));
            } catch {
              return originalSend(data);
            }
          }
          return originalSend(data);
        } catch (error) {
          console.error('[Demo Mode] Error filtering send response:', error);
          return originalSend(data);
        }
      };
    }
  }

  next();
}

const SENSITIVE_KEY_PATTERNS = [
  'apikey', 'api_key', 'secretkey', 'secret_key', 'secret', 'password', 'token',
  'accesskey', 'access_key', 'privatekey', 'private_key', 'authtoken', 'auth_token',
  'clientsecret', 'client_secret', 'smtppassword', 'smtp_password',
  'stripesecretkey', 'stripe_secret_key', 'razorpaykeysecret', 'razorpay_key_secret',
  'paypalclientsecret', 'paypal_client_secret', 'paystacksecretkey', 'paystack_secret_key',
  'mercadopagoaccesstoken', 'mercadopago_access_token', 'hashedkey', 'hashed_key',
  'credentials', 'authsid', 'auth_sid', 'webhook_secret', 'signing_secret',
];

function isPiiEmailField(keyLower: string): boolean {
  return keyLower === 'email' ||
    keyLower.endsWith('email') ||
    keyLower === 'useremail' ||
    keyLower === 'customeremail';
}

function isPiiPhoneField(keyLower: string): boolean {
  return keyLower === 'phone' ||
    keyLower === 'mobile' ||
    keyLower.endsWith('phone') ||
    keyLower.endsWith('mobile') ||
    keyLower === 'phonenumber' ||
    keyLower === 'mobilenumber';
}

function isPiiAddressField(keyLower: string): boolean {
  return keyLower === 'address' ||
    keyLower === 'streetaddress' ||
    keyLower === 'homeaddress' ||
    keyLower === 'billingaddress' ||
    keyLower === 'shippingaddress';
}

function deepFilterSensitiveData(data: any, depth: number = 0): any {
  if (depth > 10) return data;
  if (data === null || data === undefined) return data;

  if (data instanceof Date) return data;

  if (Array.isArray(data)) {
    return data.map(item => deepFilterSensitiveData(item, depth + 1));
  }

  if (typeof data !== 'object') return data;

  const result: any = {};
  for (const [key, value] of Object.entries(data)) {
    const keyLower = key.toLowerCase().replace(/[-_]/g, '');

    if (value instanceof Date) {
      result[key] = value;
    } else if (SENSITIVE_KEY_PATTERNS.some(pattern => keyLower.includes(pattern.replace(/[-_]/g, '')))) {
      result[key] = value ? '***HIDDEN***' : null;
    } else if (isPiiEmailField(keyLower) && typeof value === 'string' && value.includes('@')) {
      result[key] = maskEmail(value);
    } else if (isPiiPhoneField(keyLower) && typeof value === 'string' && value) {
      result[key] = '***-***-****';
    } else if (isPiiAddressField(keyLower) && typeof value === 'string' && value) {
      result[key] = '*** Hidden Address ***';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = deepFilterSensitiveData(value, depth + 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function maskEmail(email: string): string {
  if (!email) return email;
  const [local, domain] = email.split('@');
  if (!domain) return '***@***.***';
  const maskedLocal = local.length > 2
    ? `${local[0]}***${local[local.length - 1]}`
    : '***';
  return `${maskedLocal}@${domain}`;
}

export function initDemoMode(app: Express): void {
  if (!isDemoModeEnabled()) {
    console.log('[Demo Mode] Disabled - DEMO_MODE env not set to true');
    return;
  }

  // Ensure demo_call_limit_logs table exists
  (async () => {
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS demo_call_limit_logs (
          id SERIAL PRIMARY KEY,
          ip TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
      `);
      console.log('[Demo Mode] demo_call_limit_logs table ready');
    } catch (err: any) {
      console.error('[Demo Mode] Failed to create demo_call_limit_logs table:', err.message);
    }
  })();

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           🎭 DEMO MODE ACTIVE                               ║');
  console.log('║           Admin mutations blocked, sensitive data hidden    ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  app.use(blockAdminMutationsMiddleware);
  app.use(filterSensitiveDataMiddleware);
}

export function getDemoModeStatus(): { enabled: boolean; config: DemoModeConfig } {
  return {
    enabled: isDemoModeEnabled(),
    config,
  };
}

export function registerDemoModeRoutes(app: Express): void {
  app.get('/api/demo-mode/status', async (req: Request, res: Response) => {
    try {
      let isDemoUser = false;
      const authHeader = req.headers["authorization"];
      const token = authHeader && authHeader.split(" ")[1];
      if (token) {
        try {
          const secret = process.env.JWT_SECRET || "insecure-dev-secret-CHANGE-ME";
          const decoded = jwt.verify(token, secret) as { userId: string; role: string };
          const userId = decoded.userId;
          if (userId) {
            const userResult = await db.execute(sql`SELECT email FROM users WHERE id = ${userId} LIMIT 1`);
            const email = (userResult.rows[0]?.email as string)?.toLowerCase();

            const demoEmails = getDemoEmails();
            if (demoEmails.length > 0) {
              isDemoUser = email ? demoEmails.includes(email) : false;
            } else {
              isDemoUser = email === 'demo@diploy.in' || email === 'demo1@diploy.in';
            }
          } else {
            isDemoUser = true;
          }
        } catch {
          isDemoUser = true; // Treat as guest on verification failure
        }
      } else {
        isDemoUser = true; // Treat unauthenticated guest as demo user
      }

      const enabled = isDemoModeEnabled() && (getDemoEmails().length === 0 || isDemoUser);
      res.json({
        enabled,
        message: enabled
          ? 'Demo mode is active. Some admin features are restricted.'
          : 'Demo mode is not active.',
      });
    } catch {
      res.json({
        enabled: isDemoModeEnabled(),
        message: isDemoModeEnabled()
          ? 'Demo mode is active. Some admin features are restricted.'
          : 'Demo mode is not active.',
      });
    }
  });
}

/**
 * Check if the user has reached the daily demo limit of 3 calls per IP
 */
export async function checkDemoCallLimit(userId: string, clientIp: string): Promise<{ allowed: boolean; message?: string }> {
  try {
    const userResult = await db.execute(sql`SELECT email FROM users WHERE id = ${userId} LIMIT 1`);
    const userEmail = (userResult.rows[0]?.email as string)?.toLowerCase();
    if (!userEmail) {
      return { allowed: true };
    }

    const demoEmails = getDemoEmails();
    const isDemo = demoEmails.length > 0
      ? demoEmails.includes(userEmail)
      : (userEmail === 'demo1@diploy.in' || userEmail === 'demo@diploy.in');

    if (!isDemo) {
      return { allowed: true };
    }

    // Clean IP address
    const cleanIp = String(clientIp).trim();

    // Clean up logs older than 24 hours to keep the table size small
    await db.execute(sql`DELETE FROM demo_call_limit_logs WHERE created_at < NOW() - INTERVAL '24 hours'`);

    // Count calls from this IP in the last 24 hours
    const countResult = await db.execute(sql`
      SELECT COUNT(*)::int as count FROM demo_call_limit_logs
      WHERE ip = ${cleanIp} AND created_at >= NOW() - INTERVAL '24 hours'
    `);

    // if (Number(countResult.rows[0]?.count) >= config.maxCallsPerUserPerDay) {
    //   return {
    //     allowed: false,
    //     message: 'Demo Mode Limit: Only 3 calls are allowed per day per IP address under the demo account.'
    //   };
    // }

    return { allowed: true };
  } catch (err: any) {
    console.error('[Demo Mode] Error checking demo call limit:', err.message);
    return { allowed: true }; // Allow in case of DB error
  }
}

/**
 * Log a demo call from an IP
 */
export async function logDemoCall(userId: string, clientIp: string): Promise<void> {
  try {
    const userResult = await db.execute(sql`SELECT email FROM users WHERE id = ${userId} LIMIT 1`);
    const userEmail = (userResult.rows[0]?.email as string)?.toLowerCase();
    if (!userEmail) {
      return;
    }

    const demoEmails = getDemoEmails();
    const isDemo = demoEmails.length > 0
      ? demoEmails.includes(userEmail)
      : (userEmail === 'demo@diploy.in' || userEmail === 'demo1@diploy.in');

    if (isDemo) {
      const cleanIp = String(clientIp).trim();
      await db.execute(sql`
        INSERT INTO demo_call_limit_logs (ip) VALUES (${cleanIp})
      `);
      console.log(`[Demo Mode] Logged outbound call for demo account from IP: ${cleanIp}`);
    }
  } catch (err: any) {
    console.error('[Demo Mode] Error logging demo call:', err.message);
  }
}
