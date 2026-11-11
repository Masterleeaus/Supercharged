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
 * Appointment ElevenLabs Tool Configuration
 * 
 * Configures the book_appointment webhook tool for ElevenLabs agents.
 * When a Flow Agent needs to book an appointment during a call, ElevenLabs calls
 * our webhook with the appointment details, which saves it to the database.
 * 
 * Tool Type: "webhook" (server-side) - ElevenLabs calls our endpoint directly
 * Security: Uses a shared secret token in header for webhook authentication
 */

import { logger } from '../utils/logger';
import { getDomain } from "../utils/domain";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const PERSISTED_SECRET_PATH = path.join(process.cwd(), '.appointment-webhook-secret');

// Dev-only fallback. Used only when NODE_ENV is explicitly 'development' or 'test'.
// Never used in production: any other NODE_ENV (including unset) fails closed.
export const DEV_ONLY_APPOINTMENT_WEBHOOK_SECRET = 'DEV-ONLY-INSECURE-appointment-webhook-secret';

/**
 * Resolve the appointment webhook secret without generating a random one.
 * Order: APPOINTMENT_WEBHOOK_SECRET env var, then the secret file.
 * If neither exists, production throws (fail closed); dev/test uses the labelled dev-only value.
 */
export function resolveAppointmentWebhookSecret(
  env: NodeJS.ProcessEnv = process.env,
  secretPath: string = PERSISTED_SECRET_PATH,
): string {
  if (env.APPOINTMENT_WEBHOOK_SECRET) {
    return env.APPOINTMENT_WEBHOOK_SECRET;
  }

  try {
    if (fs.existsSync(secretPath)) {
      const fromFile = fs.readFileSync(secretPath, 'utf-8').trim();
      if (fromFile) {
        return fromFile;
      }
    }
  } catch (err) {
    // fall through to fail closed below
  }

  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') {
    logger.warn(`📅 [Appointment Tool] Using DEV-ONLY appointment webhook secret (NODE_ENV=${env.NODE_ENV})`);
    return DEV_ONLY_APPOINTMENT_WEBHOOK_SECRET;
  }

  throw new Error('Appointment webhook secret is not configured (set APPOINTMENT_WEBHOOK_SECRET or provide the secret file)');
}

let appointmentWebhookSecret: string | null = null;

export function getAppointmentWebhookSecret(): string {
  if (!appointmentWebhookSecret) {
    appointmentWebhookSecret = resolveAppointmentWebhookSecret();
  }
  return appointmentWebhookSecret;
}

export function validateAppointmentWebhookToken(providedToken: string | undefined): boolean {
  if (!providedToken) {
    return false;
  }
  let secret: string;
  try {
    secret = getAppointmentWebhookSecret();
  } catch (err) {
    // No configured secret: refuse every token rather than guess one.
    return false;
  }

  const providedBuffer = Buffer.from(providedToken);
  const secretBuffer = Buffer.from(secret);
  
  if (providedBuffer.length !== secretBuffer.length) {
    return false;
  }
  
  return crypto.timingSafeEqual(providedBuffer, secretBuffer);
}

export interface AppointmentWebhookToolConfig {
  type: "webhook";
  name: string;
  description: string;
  api_schema: {
    url: string;
    method: "GET" | "POST";
    headers?: Record<string, string>;
    request_body_schema?: Record<string, any>;
  };
}

/**
 * Get the book_appointment webhook tool configuration for ElevenLabs
 * @param agentId - The database agent ID (not ElevenLabs agent ID) for appointment ownership
 * @param callId - Optional call ID to associate the appointment with
 */
export function getBookAppointmentWebhookTool(agentId: string, callId?: string): AppointmentWebhookToolConfig {
  const domain = getDomain();
  const secret = getAppointmentWebhookSecret();
  
  const queryParams = callId ? `?callId=${encodeURIComponent(callId)}` : '';
  const webhookUrl = `${domain}/api/webhooks/elevenlabs/appointment/${secret}/${agentId}${queryParams}`;
  
  const agentIdSuffix = agentId.slice(-8);
  const toolName = `book_appointment_${agentIdSuffix}`;
  
  // Get current date for context (so AI knows what "tomorrow" means)
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentDateStr = now.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  logger.info(`📅 [Appointment Tool] Creating webhook tool config for agent ${agentId}`);
  logger.info(`   Tool name: ${toolName}`);
  logger.info(`   Current date context: ${currentDateStr}`);
  logger.info(`   Webhook URL: ${webhookUrl.replace(secret, '[TOKEN]')}`);
  
  return {
    type: "webhook",
    name: toolName,
    description: `Book an appointment for the caller. TODAY IS ${currentDateStr}. The current year is ${currentYear}. NEVER book appointments in past years - all dates must be in ${currentYear} or later. Use this when the caller wants to schedule an appointment. When they say 'tomorrow', calculate the next day from today. IMPORTANT: The caller's phone number is automatically available from the call. For contactPhone, ALWAYS set it to "{{system__caller_id}}" to use their actual calling number. Only set a different phone number if the caller explicitly provides a different one. Do NOT ask the caller for their phone number - you already have it.`,
    api_schema: {
      url: webhookUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      request_body_schema: {
        type: "object",
        properties: {
          contactName: {
            type: "string",
            description: "The name of the person booking the appointment"
          },
          contactPhone: {
            type: "string",
            description: "ALWAYS set this to the string {{system__caller_id}} which will be automatically replaced with the caller's actual phone number. Only provide a different phone number if the caller explicitly gives you a different one."
          },
          contactEmail: {
            type: "string",
            description: "Optional email address of the person"
          },
          appointmentDate: {
            type: "string",
            description: "The appointment date. Can be relative like 'tomorrow', 'next Monday', 'in 3 days' OR in YYYY-MM-DD format. The server will parse relative dates automatically."
          },
          appointmentTime: {
            type: "string",
            description: "The appointment time in HH:MM format (24-hour). Convert spoken times: '2pm' becomes '14:00', '9:30am' becomes '09:30'"
          },
          duration: {
            type: "number",
            description: "Duration in minutes (default 30)"
          },
          serviceName: {
            type: "string",
            description: "Optional name of the service/reason for appointment"
          },
          notes: {
            type: "string",
            description: "Optional additional notes about the appointment"
          },
          conversationId: {
            type: "string",
            description: "ALWAYS set this to the string {{conversation_id}} to track which call this appointment belongs to."
          }
        },
        required: ["contactName", "contactPhone", "appointmentDate", "appointmentTime", "conversationId"]
      }
    }
  };
}

/**
 * Get the appointment webhook tool for a specific ElevenLabs agent
 * Used when creating/updating Flow agents
 * 
 * @param elevenLabsAgentId - The ElevenLabs agent ID (required after agent is created in ElevenLabs)
 */
export function getAppointmentToolForAgent(elevenLabsAgentId: string): AppointmentWebhookToolConfig {
  const domain = getDomain();
  const secret = getAppointmentWebhookSecret();
  
  const webhookUrl = `${domain}/api/webhooks/elevenlabs/appointment/${secret}/${elevenLabsAgentId}`;
  
  const agentIdSuffix = elevenLabsAgentId.slice(-8);
  const toolName = `book_appointment_${agentIdSuffix}`;
  
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentDateStr = now.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  logger.info(`📅 [Appointment Tool] Creating webhook tool for ElevenLabs agent ${elevenLabsAgentId}`);
  logger.info(`   Tool name: ${toolName}`);
  logger.info(`   Current date context: ${currentDateStr}`);
  logger.info(`   Webhook URL: ${webhookUrl.replace(secret, '[TOKEN]')}`);
  
  return {
    type: "webhook",
    name: toolName,
    description: `Book an appointment for the caller. TODAY IS ${currentDateStr}. The current year is ${currentYear}. NEVER book appointments in past years - all dates must be in ${currentYear} or later. Use this when the caller wants to schedule an appointment. When they say 'tomorrow', calculate the next day from today. IMPORTANT: The caller's phone number is automatically available from the call. For contactPhone, ALWAYS set it to "{{system__caller_id}}" to use their actual calling number. Only set a different phone number if the caller explicitly provides a different one. Do NOT ask the caller for their phone number - you already have it.`,
    api_schema: {
      url: webhookUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      request_body_schema: {
        type: "object",
        properties: {
          contactName: {
            type: "string",
            description: "The name of the person booking the appointment"
          },
          contactPhone: {
            type: "string",
            description: "ALWAYS set this to the string {{system__caller_id}} which will be automatically replaced with the caller's actual phone number. Only provide a different phone number if the caller explicitly gives you a different one."
          },
          contactEmail: {
            type: "string",
            description: "Optional email address of the person"
          },
          appointmentDate: {
            type: "string",
            description: "The appointment date. Can be relative like 'tomorrow', 'next Monday', 'in 3 days' OR in YYYY-MM-DD format. The server will parse relative dates automatically."
          },
          appointmentTime: {
            type: "string",
            description: "The appointment time in HH:MM format (24-hour). Convert spoken times: '2pm' becomes '14:00', '9:30am' becomes '09:30'"
          },
          duration: {
            type: "number",
            description: "Duration in minutes (default 30)"
          },
          serviceName: {
            type: "string",
            description: "Optional name of the service/reason for appointment"
          },
          notes: {
            type: "string",
            description: "Optional additional notes about the appointment"
          },
          conversationId: {
            type: "string",
            description: "ALWAYS set this to the string {{conversation_id}} to track which call this appointment belongs to."
          }
        },
        required: ["contactName", "contactPhone", "appointmentDate", "appointmentTime", "conversationId"]
      }
    }
  };
}
