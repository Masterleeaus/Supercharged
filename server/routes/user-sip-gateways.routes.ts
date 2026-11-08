'use strict';
/**
 * User SIP Gateways Routes
 *
 * Per-user SIP gateway and custom phone number management.
 * Users can add their own SIP credentials (gateway name, username, password, proxy)
 * and attach custom phone numbers to them — all visible in /app/phone-numbers.
 *
 * Tables created on startup:
 *   - user_sip_gateways       : per-user SIP credentials
 *   - user_sip_phone_numbers  : custom phone numbers linked to a gateway
 */

import { Router, Response } from 'express';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { authenticateToken, type AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

// Ensure tables exist on first import
(async () => {
  try {
    try {
      await db.execute(sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);
    } catch (e: any) {
      logger.warn('Startup schema step skipped (enable pgcrypto extension)', { error: e?.message }, 'UserSipGateways');
    }

    // Ensure newer website_widgets columns exist
    try {
      await db.execute(sql`ALTER TABLE "website_widgets" ADD COLUMN IF NOT EXISTS "max_concurrent_calls" integer DEFAULT 5 NOT NULL;`);
    } catch (e: any) {
      logger.warn('Startup schema step skipped (add website_widgets.max_concurrent_calls)', { error: e?.message }, 'UserSipGateways');
    }
    try {
      await db.execute(sql`ALTER TABLE "website_widgets" ADD COLUMN IF NOT EXISTS "max_call_duration" integer DEFAULT 300 NOT NULL;`);
    } catch (e: any) {
      logger.warn('Startup schema step skipped (add website_widgets.max_call_duration)', { error: e?.message }, 'UserSipGateways');
    }
    try {
      await db.execute(sql`ALTER TABLE "website_widgets" ADD COLUMN IF NOT EXISTS "cooldown_minutes" integer DEFAULT 0 NOT NULL;`);
    } catch (e: any) {
      logger.warn('Startup schema step skipped (add website_widgets.cooldown_minutes)', { error: e?.message }, 'UserSipGateways');
    }
    try {
      await db.execute(sql`ALTER TABLE "website_widgets" ADD COLUMN IF NOT EXISTS "appointment_booking_enabled" boolean DEFAULT false NOT NULL;`);
    } catch (e: any) {
      logger.warn('Startup schema step skipped (add website_widgets.appointment_booking_enabled)', { error: e?.message }, 'UserSipGateways');
    }
    try {
      // Drop foreign key constraint on agent_id to allow both standard and Custom Voice Engine agents
      await db.execute(sql`ALTER TABLE "website_widgets" DROP CONSTRAINT IF EXISTS "website_widgets_agent_id_agents_id_fk";`);
    } catch (e: any) {
      logger.warn('Startup schema step skipped (drop website_widgets agent_id foreign key)', { error: e?.message }, 'UserSipGateways');
    }

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS user_sip_gateways (
        id                VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id           VARCHAR NOT NULL,
        name              TEXT NOT NULL,
        username          TEXT NOT NULL,
        password          TEXT NOT NULL,
        proxy             TEXT NOT NULL,
        register          BOOLEAN NOT NULL DEFAULT false,
        caller_id_in_from BOOLEAN NOT NULL DEFAULT true,
        is_active         BOOLEAN NOT NULL DEFAULT false,
        created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS user_sip_phone_numbers (
        id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id      VARCHAR NOT NULL,
        gateway_id   VARCHAR REFERENCES user_sip_gateways(id) ON DELETE SET NULL,
        phone_number TEXT NOT NULL,
        label        TEXT,
        agent_id     VARCHAR,
        is_active    BOOLEAN NOT NULL DEFAULT true,
        created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    // Ensure agent_id column exists if table was already created
    try {
      await db.execute(sql`
        ALTER TABLE user_sip_phone_numbers ADD COLUMN IF NOT EXISTS agent_id VARCHAR;
      `);
    } catch (e: any) {
      logger.warn('Startup schema step skipped (add user_sip_phone_numbers.agent_id)', { error: e?.message }, 'UserSipGateways');
    }

    // Ensure caller_id_in_from exists in user_sip_gateways
    try {
      await db.execute(sql`
        ALTER TABLE user_sip_gateways ADD COLUMN IF NOT EXISTS caller_id_in_from BOOLEAN NOT NULL DEFAULT true;
      `);
    } catch (e: any) {
      logger.warn('Startup schema step skipped (add user_sip_gateways.caller_id_in_from)', { error: e?.message }, 'UserSipGateways');
    }

    // Ensure sip_call_id and ve_session_id exist in leads
    try {
      await db.execute(sql`
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS sip_call_id VARCHAR;
      `);
    } catch (e: any) {
      logger.warn('Startup schema step skipped (add leads.sip_call_id)', { error: e?.message }, 'UserSipGateways');
    }

    try {
      await db.execute(sql`
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS ve_session_id VARCHAR;
      `);
    } catch (e: any) {
      logger.warn('Startup schema step skipped (add leads.ve_session_id)', { error: e?.message }, 'UserSipGateways');
    }

    // Drop the foreign key constraint since agent_id can refer to either standard or custom voice engine agents
    try {
      await db.execute(sql`
        ALTER TABLE user_sip_phone_numbers DROP CONSTRAINT IF EXISTS user_sip_phone_numbers_agent_id_fkey;
      `);
    } catch (e: any) {
      logger.warn('Startup schema step skipped (drop user_sip_phone_numbers agent_id foreign key)', { error: e?.message }, 'UserSipGateways');
    }

    // Ensure external_fonoster_phone_id column exists in sip_phone_numbers
    try {
      await db.execute(sql`
        ALTER TABLE sip_phone_numbers ADD COLUMN IF NOT EXISTS external_fonoster_phone_id TEXT;
      `);
    } catch (e: any) {
      logger.warn('Startup schema step skipped (add sip_phone_numbers.external_fonoster_phone_id)', { error: e?.message }, 'UserSipGateways');
    }

    console.log('[UserSipGateways] Tables ready');
  } catch (err: any) {
    console.error('[UserSipGateways] Failed to create tables:', err.message);
  }
})();

export function createUserSipGatewaysRoutes(): Router {
  const router = Router();

  // Reusable typed auth middleware shorthand
  const auth = authenticateToken as unknown as import('express').RequestHandler;

  const checkDemoAccount = async (req: any, res: Response, next: any) => {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const user = await db.execute(sql`SELECT email FROM users WHERE id = ${userId} LIMIT 1`);
      if (user.rows[0]?.email === '') {
        return res.status(403).json({
          success: false,
          error: 'Demo Mode Active',
          message: 'Modifying SIP configuration is disabled in demo mode.'
        });
      }
    } catch (err) {
      console.error('[UserSipGateways] checkDemoAccount error:', err);
    }
    next();
  };

  // ─── SIP Gateways ────────────────────────────────────────────────────────

  /** GET /api/user/sip-gateways */
  router.get('/api/user/sip-gateways', auth, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const result = await db.execute(sql`
        SELECT * FROM user_sip_gateways
        WHERE user_id = ${userId}
        ORDER BY created_at ASC
      `);

      let rows = result.rows;
      const userResult = await db.execute(sql`SELECT email FROM users WHERE id = ${userId} LIMIT 1`);
      const isDemoUser = userResult.rows[0]?.email === 'demo@diploy.in';

      if (isDemoUser) {
        rows = rows.map((gw: any) => ({
          ...gw,
          username: gw.username ? (gw.username.length > 2 ? `${gw.username[0]}***${gw.username[gw.username.length - 1]}` : '***') : '',
          password: '••••••••',
          proxy: gw.proxy ? (gw.proxy.length > 5 ? `${gw.proxy.slice(0, 3)}***${gw.proxy.slice(-3)}` : '***') : '',
        }));
      }

      res.json({ success: true, data: rows });
    } catch (err: any) {
      console.error('[UserSipGateways] GET gateways error:', err.message);
      res.status(500).json({ error: 'Failed to fetch gateways' });
    }
  });

  /** POST /api/user/sip-gateways */
  router.post('/api/user/sip-gateways', auth, checkDemoAccount, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { name, username, password, proxy, register, callerIdInFrom } = req.body;

      if (!name || !username || !password || !proxy) {
        return res.status(400).json({ error: 'name, username, password, and proxy are required' });
      }

      const result = await db.execute(sql`
        INSERT INTO user_sip_gateways (user_id, name, username, password, proxy, register, caller_id_in_from)
        VALUES (${userId}, ${name}, ${username}, ${password}, ${proxy}, ${register ?? false}, ${callerIdInFrom ?? true})
        RETURNING *
      `);

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err: any) {
      console.error('[UserSipGateways] POST gateway error:', err.message);
      res.status(500).json({ error: 'Failed to create gateway' });
    }
  });

  /** PUT /api/user/sip-gateways/:id */
  router.put('/api/user/sip-gateways/:id', auth, checkDemoAccount, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { id } = req.params;
      const { name, username, password, proxy, register, callerIdInFrom } = req.body;

      const existing = await db.execute(sql`
        SELECT id FROM user_sip_gateways WHERE id = ${id} AND user_id = ${userId}
      `);
      if ((existing.rows as any[]).length === 0) {
        return res.status(404).json({ error: 'Gateway not found' });
      }

      const result = await db.execute(sql`
        UPDATE user_sip_gateways SET
          name              = COALESCE(${name ?? null}, name),
          username          = COALESCE(${username ?? null}, username),
          password          = COALESCE(${password ?? null}, password),
          proxy             = COALESCE(${proxy ?? null}, proxy),
          register          = COALESCE(${register !== undefined ? register : null}, register),
          caller_id_in_from = COALESCE(${callerIdInFrom !== undefined ? callerIdInFrom : null}, caller_id_in_from),
          updated_at        = NOW()
        WHERE id = ${id} AND user_id = ${userId}
        RETURNING *
      `);

      res.json({ success: true, data: result.rows[0] });
    } catch (err: any) {
      console.error('[UserSipGateways] PUT gateway error:', err.message);
      res.status(500).json({ error: 'Failed to update gateway' });
    }
  });

  /** DELETE /api/user/sip-gateways/:id */
  router.delete('/api/user/sip-gateways/:id', auth, checkDemoAccount, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { id } = req.params;

      const existing = await db.execute(sql`
        SELECT id FROM user_sip_gateways WHERE id = ${id} AND user_id = ${userId}
      `);
      if ((existing.rows as any[]).length === 0) {
        return res.status(404).json({ error: 'Gateway not found' });
      }

      await db.execute(sql`DELETE FROM user_sip_gateways WHERE id = ${id} AND user_id = ${userId}`);
      res.json({ success: true, message: 'Gateway deleted' });
    } catch (err: any) {
      console.error('[UserSipGateways] DELETE gateway error:', err.message);
      res.status(500).json({ error: 'Failed to delete gateway' });
    }
  });

  /** POST /api/user/sip-gateways/:id/activate */
  router.post('/api/user/sip-gateways/:id/activate', auth, checkDemoAccount, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { id } = req.params;

      const existing = await db.execute(sql`
        SELECT id FROM user_sip_gateways WHERE id = ${id} AND user_id = ${userId}
      `);
      if ((existing.rows as any[]).length === 0) {
        return res.status(404).json({ error: 'Gateway not found' });
      }

      // Deactivate all user's gateways first
      await db.execute(sql`
        UPDATE user_sip_gateways SET is_active = false WHERE user_id = ${userId}
      `);

      const result = await db.execute(sql`
        UPDATE user_sip_gateways SET is_active = true
        WHERE id = ${id} AND user_id = ${userId}
        RETURNING *
      `);

      res.json({ success: true, data: result.rows[0] });
    } catch (err: any) {
      console.error('[UserSipGateways] Activate gateway error:', err.message);
      res.status(500).json({ error: 'Failed to activate gateway' });
    }
  });

  // ─── SIP Phone Numbers ────────────────────────────────────────────────────

  /** GET /api/user/sip-phone-numbers */
  router.get('/api/user/sip-phone-numbers', auth, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const result = await db.execute(sql`
        SELECT n.*, g.name AS gateway_name, g.proxy AS gateway_proxy
        FROM user_sip_phone_numbers n
        LEFT JOIN user_sip_gateways g ON g.id = n.gateway_id
        WHERE n.user_id = ${userId}
        ORDER BY n.created_at ASC
      `);

      let rows = result.rows;
      const userResult = await db.execute(sql`SELECT email FROM users WHERE id = ${userId} LIMIT 1`);
      const isDemoUser = userResult.rows[0]?.email === 'demo@diploy.in';

      if (isDemoUser) {
        rows = rows.map((pn: any) => ({
          ...pn,
          gateway_proxy: pn.gateway_proxy ? (pn.gateway_proxy.length > 5 ? `${pn.gateway_proxy.slice(0, 3)}***${pn.gateway_proxy.slice(-3)}` : '***') : '',
        }));
      }

      res.json({ success: true, data: rows });
    } catch (err: any) {
      console.error('[UserSipGateways] GET phone numbers error:', err.message);
      res.status(500).json({ error: 'Failed to fetch phone numbers' });
    }
  });

  /** POST /api/user/sip-phone-numbers */
  router.post('/api/user/sip-phone-numbers', auth, checkDemoAccount, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { phoneNumber, label, gatewayId, agentId } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({ error: 'phoneNumber is required' });
      }

      const cleanNumber = String(phoneNumber).trim();
      if (!cleanNumber.match(/^\+?[1-9]\d{6,14}$/)) {
        return res.status(400).json({
          error: 'Invalid phone number format. Use E.164 format (e.g., +1234567890)',
        });
      }

      if (gatewayId) {
        const gw = await db.execute(sql`
          SELECT id FROM user_sip_gateways WHERE id = ${gatewayId} AND user_id = ${userId}
        `);
        if ((gw.rows as any[]).length === 0) {
          return res.status(400).json({ error: 'Gateway not found or does not belong to you' });
        }
      }

      const dup = await db.execute(sql`
        SELECT id FROM user_sip_phone_numbers
        WHERE user_id = ${userId} AND phone_number = ${cleanNumber}
      `);
      if ((dup.rows as any[]).length > 0) {
        return res.status(409).json({ error: 'This phone number is already registered in your account' });
      }

      const result = await db.execute(sql`
        INSERT INTO user_sip_phone_numbers (user_id, gateway_id, phone_number, label, agent_id)
        VALUES (${userId}, ${gatewayId ?? null}, ${cleanNumber}, ${label ?? null}, ${agentId ?? null})
        RETURNING *
      `);

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err: any) {
      console.error('[UserSipGateways] POST phone number error:', err);
      res.status(500).json({ error: 'Failed to add phone number' });
    }
  });

  /** PUT /api/user/sip-phone-numbers/:id */
  router.put('/api/user/sip-phone-numbers/:id', auth, checkDemoAccount, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { id } = req.params;
      const { label, gatewayId, agentId, isActive } = req.body;

      const existing = await db.execute(sql`
        SELECT id FROM user_sip_phone_numbers WHERE id = ${id} AND user_id = ${userId}
      `);
      if ((existing.rows as any[]).length === 0) {
        return res.status(404).json({ error: 'Phone number not found' });
      }

      if (gatewayId) {
        const gw = await db.execute(sql`
          SELECT id FROM user_sip_gateways WHERE id = ${gatewayId} AND user_id = ${userId}
        `);
        if ((gw.rows as any[]).length === 0) {
          return res.status(400).json({ error: 'Gateway not found or does not belong to you' });
        }
      }

      const result = await db.execute(sql`
        UPDATE user_sip_phone_numbers SET
          label      = COALESCE(${label !== undefined ? (label ?? null) : null}, label),
          gateway_id = CASE WHEN ${gatewayId !== undefined} THEN ${gatewayId ?? null} ELSE gateway_id END,
          agent_id   = CASE WHEN ${agentId !== undefined} THEN ${agentId ?? null} ELSE agent_id END,
          is_active  = COALESCE(${isActive !== undefined ? isActive : null}, is_active),
          updated_at = NOW()
        WHERE id = ${id} AND user_id = ${userId}
        RETURNING *
      `);

      res.json({ success: true, data: result.rows[0] });
    } catch (err: any) {
      console.error('[UserSipGateways] PUT phone number error:', err);
      res.status(500).json({ error: 'Failed to update phone number' });
    }
  });

  /** DELETE /api/user/sip-phone-numbers/:id */
  router.delete('/api/user/sip-phone-numbers/:id', auth, checkDemoAccount, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { id } = req.params;

      const existing = await db.execute(sql`
        SELECT id FROM user_sip_phone_numbers WHERE id = ${id} AND user_id = ${userId}
      `);
      if ((existing.rows as any[]).length === 0) {
        return res.status(404).json({ error: 'Phone number not found' });
      }

      await db.execute(sql`DELETE FROM user_sip_phone_numbers WHERE id = ${id} AND user_id = ${userId}`);
      res.json({ success: true, message: 'Phone number deleted' });
    } catch (err: any) {
      console.error('[UserSipGateways] DELETE phone number error:', err.message);
      res.status(500).json({ error: 'Failed to delete phone number' });
    }
  });

  return router;
}
