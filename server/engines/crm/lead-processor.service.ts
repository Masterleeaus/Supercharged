'use strict';
/**
 * ============================================================
 * CRM Lead Processor Engine
 * ============================================================
 * 
 * Centralized service that monitors completed calls from ALL 
 * telephony engines and automatically creates qualified CRM leads.
 * 
 * Supported Engines:
 * - ElevenLabs + Twilio (calls table)
 * - Plivo + OpenAI (plivo_calls table)
 * - Twilio + OpenAI (twilio_openai_calls table)
 * 
 * Qualification Criteria (in priority order):
 * 1. appointment_booked - Appointment was scheduled
 * 2. form_submitted - Form data was collected
 * 3. call_transfer - Call was transferred to human
 * 4. need_follow_up - AI determined follow-up needed
 * 5. hot - Engagement score >= 70
 * 6. warm - Engagement score >= 40
 * 
 * Calls that don't meet any criteria are not added to CRM.
 */

import { db } from '../../db';
import { leads, calls, plivoCalls, twilioOpenaiCalls, sipCalls, appointments, AI_LEAD_CATEGORIES, type AILeadCategory } from '@shared/schema';
import { CRMStorage } from '../../storage/crm-storage';
import { eq, and, or, sql } from 'drizzle-orm';
import { logger } from '../../utils/logger';

export interface CallData {
  id: string;
  userId: string;
  companyId?: string | null;
  phoneNumber: string;
  fromNumber?: string | null;
  toNumber?: string | null;
  callDirection: 'incoming' | 'outgoing';
  status: string;
  duration?: number | null;
  transcript?: string | null;
  aiSummary?: string | null;
  sentiment?: string | null;
  classification?: string | null;
  wasTransferred?: boolean;
  transferredTo?: string | null;
  campaignId?: string | null;
  incomingConnectionId?: string | null;
  metadata?: Record<string, unknown> | null;
  aiInsights?: Record<string, unknown> | null;  // ElevenLabs stores insights here
  engine: 'elevenlabs-twilio' | 'plivo-openai' | 'twilio-openai' | 'elevenlabs-sip' | 'openai-sip' | string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  company?: string | null;
}

export interface LeadQualification {
  qualified: boolean;
  category: AILeadCategory | null;
  score: number;
  hasAppointment: boolean;
  hasFormSubmission: boolean;
  hasTransfer: boolean;
  hasCallback: boolean;
  appointmentData?: Record<string, unknown>;
  formData?: Record<string, unknown>;
}

export class CRMLeadProcessor {
  private static readonly LOG_PREFIX = '[CRM Lead Processor]';
  
  // Minimum quality thresholds
  private static readonly MIN_DURATION_SECONDS = 10;  // At least 10 seconds
  private static readonly MIN_TRANSCRIPT_LENGTH = 20; // At least 20 characters

  /**
   * Resolve the correct phone number based on call direction
   * For incoming calls: customer is the caller (fromNumber)
   * For outgoing calls: customer is the recipient (toNumber)
   * Handles undefined callDirection and engine-specific metadata
   */
  private static resolveLeadPhone(callData: CallData): string {
    let phone: string | null = null;
    
    // First, try engine-specific metadata fields (these are most reliable)
    const metadata = callData.metadata || {};
    if (metadata.customerPhone) {
      phone = String(metadata.customerPhone);
    } else if (metadata.callerPhone) {
      phone = String(metadata.callerPhone);
    }
    
    // If no metadata phone, resolve based on call direction
    if (!phone || !this.isValidPhone(phone)) {
      const direction = callData.callDirection?.toLowerCase();
      
      if (direction === 'incoming') {
        // For incoming calls, the customer called us - use fromNumber
        phone = callData.fromNumber || callData.phoneNumber || callData.toNumber || null;
      } else if (direction === 'outgoing') {
        // For outgoing calls, we called the customer - use toNumber
        phone = callData.toNumber || callData.phoneNumber || callData.fromNumber || null;
      } else {
        // Unknown direction - try both fields, prefer non-empty ones
        phone = callData.fromNumber || callData.toNumber || callData.phoneNumber || null;
      }
    }
    
    // Final validation, normalization and cleanup
    if (phone && this.isValidPhone(phone)) {
      return this.normalizePhone(phone);
    }
    
    return 'Unknown';
  }

  /**
   * Check if a phone number is valid dialable number
   * Rejects SIP identifiers, client IDs, and non-phone strings
   */
  private static isValidPhone(phone: string | null | undefined): boolean {
    if (!phone) return false;
    const cleaned = phone.trim().toLowerCase();
    
    // Reject common placeholder values
    if (cleaned === '' || 
        cleaned === 'unknown' || 
        cleaned === 'anonymous' || 
        cleaned === 'null' || 
        cleaned === 'undefined') {
      return false;
    }
    
    // Reject SIP/client identifiers (Twilio warm-transfer uses these)
    if (cleaned.startsWith('client:') || 
        cleaned.startsWith('sip:') || 
        cleaned.startsWith('agent:') ||
        cleaned.includes('@')) {
      return false;
    }
    
    // Extract just the digits from the phone number
    const digitsOnly = phone.replace(/\D/g, '');
    
    // Must have at least 5 digits (covers short codes) and at most 15 (E.164 max)
    if (digitsOnly.length < 5 || digitsOnly.length > 15) {
      return false;
    }
    
    // Must have at least 50% digits (to reject strings like "CallAgent123")
    const digitRatio = digitsOnly.length / cleaned.replace(/\s/g, '').length;
    if (digitRatio < 0.5) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Normalize phone number to E.164 format for consistent deduplication
   * Always outputs +<digits> format when possible
   */
  private static normalizePhone(phone: string): string {
    // Remove common prefixes
    let normalized = phone.trim();
    
    // Remove whatsapp/tel prefixes
    normalized = normalized.replace(/^(whatsapp:|tel:|phone:)/i, '');
    
    // Extract all digits
    const digitsOnly = normalized.replace(/[^\d]/g, '');
    
    // Determine if original had + prefix
    const hadPlus = normalized.startsWith('+');
    
    // For E.164 compliance, always add + prefix for international numbers
    if (digitsOnly.length >= 10) {
      // If already had +, keep it; otherwise add it for 10+ digit numbers
      return '+' + digitsOnly;
    } else if (digitsOnly.length >= 5) {
      // Short codes or local numbers - preserve original format but clean
      return hadPlus ? '+' + digitsOnly : digitsOnly;
    }
    
    // Fallback - return cleaned version
    return digitsOnly || normalized;
  }

  /**
   * Check if a call meets minimum quality standards for lead creation
   * Requires either meaningful duration OR transcript content OR high-value signals
   */
  private static meetsQualityThreshold(callData: CallData): { passed: boolean; reason: string } {
    // Check for high-value signals that bypass duration/transcript requirements
    // These indicate valid business outcomes even on short/failed-transcription calls
    const metadata = callData.metadata || {};
    const aiInsights = (callData.aiInsights || metadata.aiInsights || {}) as Record<string, unknown>;
    
    // Check for appointment booking indicators
    const hasAppointment = 
      metadata.appointmentBooked === true ||
      metadata.hasAppointment === true ||
      aiInsights.primaryOutcome === 'appointment_booked' ||
      aiInsights.appointmentBooked === true ||
      metadata.appointmentDetails !== undefined ||
      metadata.appointmentData !== undefined;
    
    // Check for form submission indicators
    const hasForm = 
      metadata.formSubmitted === true ||
      metadata.hasFormSubmission === true ||
      aiInsights.primaryOutcome === 'form_submitted' ||
      aiInsights.formSubmitted === true ||
      metadata.formData !== undefined ||
      metadata.collectedData !== undefined;
    
    // Check for transfer/callback indicators
    const hasTransfer = callData.wasTransferred === true || aiInsights.primaryOutcome === 'call_transfer';
    const hasCallback = aiInsights.primaryOutcome === 'need_follow_up' || aiInsights.needsFollowUp === true;
    
    logger.info(`${this.LOG_PREFIX} [Quality Threshold Check] Call ID: ${callData.id}`);
    logger.info(`  - Duration: ${callData.duration || 0}s (Min: ${this.MIN_DURATION_SECONDS}s)`);
    logger.info(`  - Transcript length: ${callData.transcript?.trim().length || 0} chars (Min: ${this.MIN_TRANSCRIPT_LENGTH} chars)`);
    logger.info(`  - High-value indicators: Appointment=${hasAppointment}, Form=${hasForm}, Transfer=${hasTransfer}, Callback=${hasCallback}`);
    
    // Explicitly reject extremely short calls (under 10 seconds) unless they have a high-value outcome
    const duration = callData.duration ?? 0;
    if (duration > 0 && duration < this.MIN_DURATION_SECONDS && !hasAppointment && !hasForm && !hasTransfer && !hasCallback) {
      const failReason = `Call duration too short (${duration}s) without high-value business outcome`;
      logger.info(`  - Passed: False (Reason: ${failReason})`);
      return { passed: false, reason: failReason };
    }

    // High-value signals bypass duration/transcript requirements
    if (hasAppointment || hasForm || hasTransfer || hasCallback) {
      const activeSignals = [
        hasAppointment && 'Appointment Booked',
        hasForm && 'Form Submitted',
        hasTransfer && 'Call Transferred',
        hasCallback && 'Callback Requested'
      ].filter(Boolean).join(', ');
      logger.info(`  - Passed: True (bypassed via high-value outcome: ${activeSignals})`);
      return { passed: true, reason: `Has high-value business outcome: ${activeSignals}` };
    }
    
    // Check if there's a meaningful transcript
    const hasTranscript = callData.transcript && callData.transcript.trim().length >= this.MIN_TRANSCRIPT_LENGTH;
    
    // Check if there's meaningful duration
    const hasDuration = callData.duration && callData.duration >= this.MIN_DURATION_SECONDS;
    
    // Check for explicit qualification signals (these bypass duration/transcript requirements)
    // Only count actual qualification classifications, ignoring generic call statuses like 'completed'
    const validQualificationClassifications = ['hot', 'warm', 'cold', 'qualified', 'interested', 'not_interested', 'need_follow_up'];
    const hasValidClassification = callData.classification && 
      validQualificationClassifications.includes(callData.classification.trim().toLowerCase());

    const hasExplicitSignal = 
      (callData.aiSummary && callData.aiSummary.trim().length > 10) ||
      hasValidClassification ||
      (callData.sentiment && callData.sentiment.trim() !== '');
    
    logger.info(`  - Standard Checks: HasTranscript=${!!hasTranscript}, HasDuration=${!!hasDuration}, HasExplicitSignal=${!!hasExplicitSignal}`);
    logger.info(`  - Explicit signals: AI Summary length=${callData.aiSummary?.trim().length || 0}, Classification=${callData.classification || 'none'} (valid=${!!hasValidClassification}), Sentiment=${callData.sentiment || 'none'}`);
    
    if (hasTranscript || hasDuration || hasExplicitSignal) {
      logger.info(`  - Passed: True (Meets standard quality thresholds)`);
      return { passed: true, reason: 'Meets quality threshold' };
    }
    
    const failReason = `Call too short (${callData.duration || 0}s) and no transcript (${callData.transcript?.length || 0} chars)`;
    logger.info(`  - Passed: False (Reason: ${failReason})`);
    return { 
      passed: false, 
      reason: failReason
    };
  }

  /**
   * Process a completed call and create a lead if it qualifies
   */
  static async processCall(callData: CallData): Promise<{ leadId: string | null; qualification: LeadQualification }> {
    logger.info(`${this.LOG_PREFIX} Processing call ${callData.id} from engine: ${callData.engine}`);
    
    // Check minimum quality threshold first
    const qualityCheck = this.meetsQualityThreshold(callData);
    if (!qualityCheck.passed) {
      logger.warn(`${this.LOG_PREFIX} Call ${callData.id} rejected: ${qualityCheck.reason}`);
      return { 
        leadId: null, 
        qualification: {
          qualified: false,
          category: null,
          score: 0,
          hasAppointment: false,
          hasFormSubmission: false,
          hasTransfer: false,
          hasCallback: false,
        }
      };
    }

    try {
      // Qualify the call first
      const qualification = await this.qualifyCall(callData);
      
      if (!qualification.qualified) {
        logger.info(`${this.LOG_PREFIX} Call ${callData.id} does not qualify for CRM (no category matched)`);
        return { leadId: null, qualification };
      }

      // Update call classification to match calculated category
      if (qualification.category) {
        await this.updateCallClassification(callData.id, callData.engine, qualification.category);
      }

      // Check if lead already exists for this call (by phone number)
      const existingLead = await this.findExistingLead(callData);
      if (existingLead) {
        // Update existing lead with new call data and qualification
        const updatedLead = await this.updateExistingLead(existingLead, callData, qualification);
        if (updatedLead) {
          const categoryChanged = existingLead.aiCategory !== updatedLead.aiCategory;
          logger.info(`${this.LOG_PREFIX} Updated existing lead ${updatedLead.id} - aiCategory: ${existingLead.aiCategory || 'none'} -> ${updatedLead.aiCategory || qualification.category}${categoryChanged ? ' (changed)' : ''}`);
          return {
            leadId: updatedLead.id,
            qualification,
          };
        }
        // Fall through to create new lead if update failed
        logger.info(`${this.LOG_PREFIX} Update returned null, creating new lead`);
      }

      // Create new lead
      const lead = await this.createLeadFromCall(callData, qualification);
      if (!lead) {
        logger.error(`${this.LOG_PREFIX} Failed to create lead for call ${callData.id} - createLeadFromCall returned null`);
        return { leadId: null, qualification };
      }
      logger.info(`${this.LOG_PREFIX} Created lead ${lead.id} with category: ${qualification.category}`);

      // Log activity
      try {
        await CRMStorage.createActivity({
          userId: callData.userId,
          leadId: lead.id,
          activityType: 'call',
          title: `Auto-created from ${callData.engine} call`,
          description: `Lead auto-created from ${callData.engine} ${callData.callDirection} call`,
          metadata: {
            callId: callData.id,
          } as any,
        });
      } catch (activityError) {
        console.error(`${this.LOG_PREFIX} Failed to create activity:`, activityError);
      }

      // Trigger form.lead_created webhook event
      try {
        const { webhookDeliveryService } = await import('../../services/webhook-delivery');
        
        await webhookDeliveryService.triggerEvent(callData.companyId ?? null, callData.userId, 'form.lead_created', {
          lead: {
            id: lead.id,
            name: lead.firstName || lead.lastName ? `${lead.firstName || ''} ${lead.lastName || ''}`.trim() : 'Unknown',
            email: lead.email,
            phone: lead.phone,
            company: lead.company,
            source: callData.campaignId ? 'Outbound Campaign' : 'Incoming Call',
            status: lead.stage || 'new',
            createdAt: lead.createdAt ? new Date(lead.createdAt).toISOString() : new Date().toISOString(),
          },
          call: {
            id: callData.id,
            duration: callData.duration || 0,
            direction: callData.callDirection || 'incoming',
            phoneNumber: callData.phoneNumber || null,
          },
          qualification: {
            score: qualification.score,
            category: qualification.category,
            hasAppointment: qualification.hasAppointment,
            hasFormSubmission: qualification.hasFormSubmission,
            hasTransfer: qualification.hasTransfer,
            hasCallback: qualification.hasCallback,
          }
        }, callData.campaignId);
        
        logger.info(`${this.LOG_PREFIX} Triggered form.lead_created webhook event for lead ${lead.id}`);
      } catch (webhookError: any) {
        console.error(`${this.LOG_PREFIX} Failed to trigger form.lead_created webhook:`, webhookError.message);
      }

      return { leadId: lead.id, qualification };
    } catch (error) {
      console.error(`${this.LOG_PREFIX} Error processing call ${callData.id}:`, error);
      throw error;
    }
  }

  /**
   * Qualify a call and determine its CRM category
   * Priority order: appointment_booked > form_submitted > call_transfer > need_follow_up > hot > warm
   */
  static async qualifyCall(callData: CallData): Promise<LeadQualification> {
    const metadata = callData.metadata || {};
    
    // Extract insights from multiple sources - callData.aiInsights takes priority (ElevenLabs stores here)
    // Then check metadata.aiInsights, then metadata itself
    const aiInsights = (callData.aiInsights || metadata.aiInsights || metadata) as Record<string, unknown>;
    
    // Merge aiInsights into metadata for downstream checks
    const mergedMetadata = { ...metadata, ...aiInsights } as Record<string, unknown>;
    const primaryOutcome = aiInsights.primaryOutcome as string | undefined;
    const engagementScore = this.extractEngagementScore(callData, aiInsights);
    
    // Check for appointment booking - use mergedMetadata for comprehensive check
    let hasAppointment = this.checkAppointmentBooked(callData, mergedMetadata);
    let appointmentData = hasAppointment ? this.extractAppointmentData(mergedMetadata) : undefined;
    
    if (!hasAppointment) {
      const dbAppointment = await this.checkAppointmentInDatabase(callData);
      if (dbAppointment) {
        hasAppointment = true;
        appointmentData = dbAppointment;
      }
    }
    
    // Check for form submission - use mergedMetadata for comprehensive check
    const hasFormSubmission = this.checkFormSubmitted(callData, mergedMetadata);
    const formData = hasFormSubmission ? this.extractFormData(mergedMetadata) : undefined;
    
    // Check for call transfer
    const hasTransfer = callData.wasTransferred === true || primaryOutcome === 'call_transfer';
    
    // Check for callback/follow-up needed
    const hasCallback = primaryOutcome === 'need_follow_up' || 
                        this.checkNeedsFollowUp(callData, aiInsights);

    // Determine category based on priority
    let category: AILeadCategory | null = null;

    if (hasAppointment) {
      category = AI_LEAD_CATEGORIES.APPOINTMENT_BOOKED;
    } else if (hasFormSubmission) {
      category = AI_LEAD_CATEGORIES.FORM_SUBMITTED;
    } else if (hasTransfer) {
      category = AI_LEAD_CATEGORIES.CALL_TRANSFER;
    } else if (hasCallback) {
      category = AI_LEAD_CATEGORIES.NEED_FOLLOW_UP;
    } else if (engagementScore >= 70) {
      category = AI_LEAD_CATEGORIES.HOT;
    } else if (engagementScore >= 40) {
      category = AI_LEAD_CATEGORIES.WARM;
    } else if (engagementScore >= 20) {
      category = AI_LEAD_CATEGORIES.NEUTRAL;
    } else {
      category = AI_LEAD_CATEGORIES.COLD;
    }

    const qualified = category !== null;

    logger.info(`${this.LOG_PREFIX} Qualification result for call ${callData.id}:`, {
      qualified,
      category,
      score: engagementScore,
      hasAppointment,
      hasFormSubmission,
      hasTransfer,
      hasCallback,
      primaryOutcome,
    });

    return {
      qualified,
      category,
      score: engagementScore,
      hasAppointment,
      hasFormSubmission,
      hasTransfer,
      hasCallback,
      appointmentData,
      formData,
    };
  }

  /**
   * Extract engagement score from call data or AI insights
   */
  private static extractEngagementScore(callData: CallData, aiInsights: Record<string, unknown>): number {
    // Try to get score from various sources
    const sources = [
      aiInsights.engagementScore,
      aiInsights.leadScore,
      aiInsights.score,
      (callData.metadata as any)?.leadScore,
      (callData.metadata as any)?.engagementScore,
    ];

    for (const source of sources) {
      if (typeof source === 'number' && source >= 0 && source <= 100) {
        return source;
      }
    }

    // Calculate score based on sentiment and classification if no explicit score
    return this.calculateScoreFromSentiment(callData);
  }

  /**
   * Calculate engagement score based on sentiment, classification, and call quality
   * Balanced scoring - requires signals to qualify but tolerant of formatting differences
   */
  private static calculateScoreFromSentiment(callData: CallData): number {
    // Start with a moderate base score
    let score = 30;
    let hasAnySignal = false;

    // Normalize and trim sentiment for case-insensitive matching
    const sentiment = (callData.sentiment || '').trim().toLowerCase();
    if (sentiment === 'positive' || sentiment === 'pos' || sentiment.includes('positive')) {
      score += 30;
      hasAnySignal = true;
    } else if (sentiment === 'neutral' || sentiment.includes('neutral')) {
      score += 15;
      hasAnySignal = true;
    } else if (sentiment === 'negative' || sentiment === 'neg' || sentiment.includes('negative')) {
      score -= 10;
      hasAnySignal = true;
    }

    // Normalize and trim classification for case-insensitive matching
    const classification = (callData.classification || '').trim().toLowerCase();
    if (classification === 'hot' || classification === 'interested' || classification === 'qualified' || 
        classification.includes('hot') || classification.includes('interested')) {
      score += 25;
      hasAnySignal = true;
    } else if (classification === 'warm' || classification.includes('warm')) {
      score += 15;
      hasAnySignal = true;
    } else if (classification === 'neutral' || classification.includes('neutral')) {
      score += 5;
      hasAnySignal = true;
    } else if (classification === 'cold' || classification === 'not_interested' || 
               classification.includes('cold') || classification.includes('not interested')) {
      score -= 10;
      hasAnySignal = true;
    }

    // Adjust based on call duration (longer calls often indicate interest)
    if (callData.duration) {
      if (callData.duration >= 180) {
        score += 20; // 3+ minute call - strong engagement
        hasAnySignal = true;
      } else if (callData.duration >= 120) {
        score += 15; // 2+ minute call
        hasAnySignal = true;
      } else if (callData.duration >= 60) {
        score += 10; // 1+ minute call
        hasAnySignal = true;
      } else if (callData.duration >= 30) {
        score += 5; // 30+ seconds
        hasAnySignal = true;
      }
    }

    // Bonus for having transcript (indicates meaningful conversation)
    if (callData.transcript && callData.transcript.trim().length > 50) {
      score += 10;
      hasAnySignal = true;
    }

    // Bonus for having AI summary (indicates analyzed call)
    if (callData.aiSummary && callData.aiSummary.trim().length > 20) {
      score += 5;
      hasAnySignal = true;
    }

    // If no signals at all, keep score below warm threshold
    if (!hasAnySignal) {
      score = 25; // Below warm threshold (40)
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Check if appointment was booked during the call
   */
  private static checkAppointmentBooked(callData: CallData, metadata: Record<string, unknown>): boolean {
    // Check explicit flags
    if (metadata.appointmentBooked === true) return true;
    if (metadata.hasAppointment === true) return true;
    
    // Check aiInsights
    const aiInsights = metadata.aiInsights as Record<string, unknown> | undefined;
    if (aiInsights?.primaryOutcome === 'appointment_booked') return true;
    if (aiInsights?.appointmentBooked === true) return true;

    // Check for appointment data presence
    if (metadata.appointmentDetails || metadata.appointmentData) return true;

    // Check transcript for appointment keywords if available
    if (callData.aiSummary) {
      const summary = callData.aiSummary.toLowerCase();
      if (summary.includes('appointment scheduled') || 
          summary.includes('meeting booked') ||
          summary.includes('appointment booked') ||
          summary.includes('scheduled for') ||
          summary.includes('meeting scheduled') ||
          summary.includes('scheduled a meeting') ||
          summary.includes('scheduled an appointment') ||
          /(?:scheduled|booked)\s+(?:[a-zA-Z0-9-]+\s+){0,10}(?:meeting|appointment)/i.test(summary) ||
          /(?:meeting|appointment)\s+(?:[a-zA-Z0-9-]+\s+){0,10}(?:scheduled|booked)/i.test(summary)) {
        return true;
      }
    }

    return false;
  }

  private static async checkAppointmentInDatabase(callData: CallData): Promise<Record<string, unknown> | null> {
    try {
      const formatAppt = (appt: any, matchedBy: string) => {
        logger.info(`${this.LOG_PREFIX} Found appointment ${appt.id} in database for call ${callData.id} (matched by: ${matchedBy})`);
        return {
          appointmentId: appt.id,
          contactName: appt.contactName,
          contactPhone: appt.contactPhone,
          date: appt.appointmentDate,
          time: appt.appointmentTime,
          bookedAt: appt.createdAt?.toISOString(),
        };
      };

      // Strategy 1: Match by callId (most reliable)
      const byCallId = await db
        .select()
        .from(appointments)
        .where(eq(appointments.callId, callData.id))
        .limit(1);

      if (byCallId.length > 0) {
        return formatAppt(byCallId[0], 'callId');
      }

      // Strategy 2: Match by ElevenLabs conversation ID stored in appointment metadata
      // This handles incoming calls where the call record didn't exist when the appointment was created
      const conversationId = callData.metadata?.elevenLabsConversationId
        || callData.metadata?.conversationId
        || (callData.metadata as any)?.webhookMetadata?.conversation_id;
      
      if (conversationId) {
        try {
          const byConversationId = await db
            .select()
            .from(appointments)
            .where(and(
              eq(appointments.userId, callData.userId),
              sql`${appointments.createdAt} > NOW() - INTERVAL '30 minutes'`,
              sql`(${appointments.metadata}->>'elevenLabsConversationId' = ${conversationId} OR ${appointments.metadata}->>'conversationId' = ${conversationId})`
            ))
            .limit(1);

          if (byConversationId.length > 0) {
            return formatAppt(byConversationId[0], `conversationId(${conversationId})`);
          }
        } catch (convErr: any) {
          console.warn(`${this.LOG_PREFIX} Conversation ID appointment lookup failed: ${convErr.message}`);
        }
      }

      // Strategy 3: Match by phone number
      const phone = callData.phoneNumber || callData.fromNumber || callData.toNumber;
      if (!phone) return null;

      const normalizedPhone = phone.replace(/\D/g, '').slice(-10);
      if (normalizedPhone.length < 7) return null;

      const byPhone = await db
        .select()
        .from(appointments)
        .where(and(
          eq(appointments.userId, callData.userId),
          sql`${appointments.createdAt} > NOW() - INTERVAL '30 minutes'`,
          sql`RIGHT(REGEXP_REPLACE(${appointments.contactPhone}, '[^0-9]', '', 'g'), 10) = ${normalizedPhone}`
        ))
        .limit(1);

      if (byPhone.length > 0) {
        return formatAppt(byPhone[0], `userId+phone(${normalizedPhone})`);
      }

      return null;
    } catch (error: any) {
      console.warn(`${this.LOG_PREFIX} Appointment DB check failed for call ${callData.id}: ${error.message}`);
      return null;
    }
  }

  /**
   * Check if form was submitted during the call
   */
  private static checkFormSubmitted(callData: CallData, metadata: Record<string, unknown>): boolean {
    // Check explicit flags
    if (metadata.formSubmitted === true) return true;
    if (metadata.hasFormSubmission === true) return true;
    
    // Check aiInsights
    const aiInsights = metadata.aiInsights as Record<string, unknown> | undefined;
    if (aiInsights?.primaryOutcome === 'form_submitted') return true;
    if (aiInsights?.formSubmitted === true) return true;

    // Check for form data presence
    if (metadata.formData || metadata.collectedData) return true;
    if (aiInsights?.formData || aiInsights?.collectedData) return true;

    return false;
  }

  /**
   * Check if call needs follow-up
   */
  private static checkNeedsFollowUp(callData: CallData, aiInsights: Record<string, unknown>): boolean {
    // Check classification
    const classification = (callData.classification || '').toLowerCase();
    if (classification === 'follow_up' || classification === 'callback') return true;

    // Check AI insights
    if (aiInsights.needsFollowUp === true) return true;
    if (aiInsights.followUpRequired === true) return true;
    if (aiInsights.callbackRequested === true) return true;

    // Check aiNextAction suggestion
    const nextAction = (aiInsights.aiNextAction || aiInsights.nextAction || '') as string;
    if (nextAction.toLowerCase().includes('follow') || 
        nextAction.toLowerCase().includes('callback') ||
        nextAction.toLowerCase().includes('call back')) {
      return true;
    }

    return false;
  }

  /**
   * Extract appointment data from metadata
   */
  private static extractAppointmentData(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
    return (metadata.appointmentDetails || metadata.appointmentData || 
            (metadata.aiInsights as any)?.appointmentDetails) as Record<string, unknown> | undefined;
  }

  /**
   * Extract form data from metadata
   */
  private static extractFormData(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
    return (metadata.formData || metadata.collectedData || 
            (metadata.aiInsights as any)?.formData || 
            (metadata.aiInsights as any)?.collectedData) as Record<string, unknown> | undefined;
  }

  /**
   * Find existing lead for a call
   * Respects campaign/incoming scope to prevent collapsing different campaigns' leads
   */
  private static async findExistingLead(callData: CallData): Promise<typeof leads.$inferSelect | null> {
    const phoneNumber = this.resolveLeadPhone(callData);
    const hasValidPhone = phoneNumber && phoneNumber !== 'Unknown';

    // For ElevenLabs-Twilio engine, check callId first
    if (callData.engine === 'elevenlabs-twilio') {
      const [existingByCallId] = await db
        .select()
        .from(leads)
        .where(and(
          eq(leads.userId, callData.userId),
          eq(leads.callId, callData.id)
        ))
        .limit(1);
      
      if (existingByCallId) return existingByCallId;
    }

    // For campaign calls, scope by campaignId to prevent different campaigns from sharing leads
    if (callData.campaignId && hasValidPhone) {
      const [existingByCampaign] = await db
        .select()
        .from(leads)
        .where(and(
          eq(leads.userId, callData.userId),
          eq(leads.phone, phoneNumber),
          eq(leads.campaignId, callData.campaignId)
        ))
        .limit(1);
      
      if (existingByCampaign) return existingByCampaign;
    }

    // For incoming calls, scope by incomingConnectionId if available
    if (callData.incomingConnectionId && hasValidPhone) {
      const [existingByConnection] = await db
        .select()
        .from(leads)
        .where(and(
          eq(leads.userId, callData.userId),
          eq(leads.phone, phoneNumber),
          eq(leads.incomingConnectionId, callData.incomingConnectionId)
        ))
        .limit(1);
      
      if (existingByConnection) return existingByConnection;
    }

    // Fallback: Check by phone number without source scope (for incoming without connection ID)
    if (hasValidPhone && !callData.campaignId) {
      const [existingByPhone] = await db
        .select()
        .from(leads)
        .where(and(
          eq(leads.userId, callData.userId),
          eq(leads.phone, phoneNumber),
          eq(leads.sourceType, 'incoming')
        ))
        .limit(1);

      return existingByPhone || null;
    }

    return null;
  }

  /**
   * Create a lead from call data
   */
  private static async createLeadFromCall(
    callData: CallData, 
    qualification: LeadQualification
  ): Promise<typeof leads.$inferSelect> {
    // Use the centralized phone resolution helper
    const phoneNumber = this.resolveLeadPhone(callData);

    // Determine source type and IDs
    const sourceType = callData.campaignId ? 'campaign' : 'incoming';

    const leadData = {
      userId: callData.userId,
      sourceType,
      campaignId: callData.campaignId || null,
      incomingConnectionId: callData.incomingConnectionId || null,
      phone: phoneNumber,
      firstName: callData.firstName || null,
      lastName: callData.lastName || null,
      email: callData.email || null,
      company: callData.company || null,
      stage: 'new',
      leadScore: qualification.score,
      aiSummary: callData.aiSummary,
      aiNextAction: this.generateNextAction(qualification),
      sentiment: callData.sentiment,
      aiCategory: qualification.category,
      hasAppointment: qualification.hasAppointment,
      hasFormSubmission: qualification.hasFormSubmission,
      hasTransfer: qualification.hasTransfer,
      hasCallback: qualification.hasCallback,
      appointmentDetails: qualification.appointmentData,
      formData: qualification.formData,
      transferredTo: callData.transferredTo,
      transferredAt: callData.wasTransferred ? new Date() : null,
      callId: callData.engine === 'elevenlabs-twilio' ? callData.id : null,
      plivoCallId: callData.engine === 'plivo-openai' ? callData.id : null,
      twilioOpenaiCallId: callData.engine === 'twilio-openai' ? callData.id : null,
      sipCallId: (callData.engine === 'elevenlabs-sip' || callData.engine === 'openai-sip') ? callData.id : null,
      veSessionId: callData.engine === 'custom-voice-engine' ? callData.id : null,
    };

    return CRMStorage.createLead(leadData as any);
  }

  /**
   * Update an existing lead with new call data and qualification
   */
  private static async updateExistingLead(
    existingLead: typeof leads.$inferSelect,
    callData: CallData,
    qualification: LeadQualification
  ): Promise<typeof leads.$inferSelect | null> {
    const updates: Record<string, unknown> = {};

    // Update contact details if not already present
    if (callData.firstName && !existingLead.firstName) {
      updates.firstName = callData.firstName;
    }
    if (callData.lastName && !existingLead.lastName) {
      updates.lastName = callData.lastName;
    }
    if (callData.email && !existingLead.email) {
      updates.email = callData.email;
    }
    if (callData.company && !existingLead.company) {
      updates.company = callData.company;
    }

    // Update score if higher
    if (qualification.score > (existingLead.leadScore || 0)) {
      updates.leadScore = qualification.score;
    }

    // Update category based on outcome type:
    // - "Action" categories (appointment, form, transfer, follow_up) always update - these represent specific call outcomes
    // - "Sentiment" categories (hot, warm) only update if current category is also sentiment-based or null
    // This ensures action outcomes are always visible while preserving high-value leads
    const actionCategories: string[] = [
      AI_LEAD_CATEGORIES.APPOINTMENT_BOOKED,
      AI_LEAD_CATEGORIES.FORM_SUBMITTED,
      AI_LEAD_CATEGORIES.CALL_TRANSFER,
      AI_LEAD_CATEGORIES.NEED_FOLLOW_UP,
    ];
    const sentimentCategories: string[] = [
      AI_LEAD_CATEGORIES.HOT,
      AI_LEAD_CATEGORIES.WARM,
      AI_LEAD_CATEGORIES.NEUTRAL,
      AI_LEAD_CATEGORIES.COLD,
    ];
    
    const isNewCategoryAction = qualification.category && actionCategories.includes(qualification.category);
    const isExistingCategorySentiment = !existingLead.aiCategory || sentimentCategories.includes(existingLead.aiCategory);
    
    // Always update for action categories, or update sentiment if current is also sentiment/null
    if (qualification.category && (isNewCategoryAction || isExistingCategorySentiment)) {
      updates.aiCategory = qualification.category;
      updates.aiNextAction = this.generateNextAction(qualification);
    }

    // Update flags - only set to true, never false (accumulate)
    if (qualification.hasAppointment && !existingLead.hasAppointment) {
      updates.hasAppointment = true;
      if (qualification.appointmentData) {
        updates.appointmentDetails = qualification.appointmentData;
      }
    }
    if (qualification.hasFormSubmission && !existingLead.hasFormSubmission) {
      updates.hasFormSubmission = true;
      if (qualification.formData) {
        updates.formData = qualification.formData;
      }
    }
    if (qualification.hasTransfer && !existingLead.hasTransfer) {
      updates.hasTransfer = true;
      if (callData.transferredTo) {
        updates.transferredTo = callData.transferredTo;
        updates.transferredAt = new Date();
      }
    }
    if (qualification.hasCallback && !existingLead.hasCallback) {
      updates.hasCallback = true;
    }

    // Update summary/sentiment if newer call has them
    if (callData.aiSummary) {
      updates.aiSummary = callData.aiSummary;
    }
    if (callData.sentiment) {
      updates.sentiment = callData.sentiment;
    }

    // Update source IDs if not already set
    if (!existingLead.campaignId && callData.campaignId) {
      updates.campaignId = callData.campaignId;
      updates.sourceType = 'campaign';
    }
    if (!existingLead.incomingConnectionId && callData.incomingConnectionId) {
      updates.incomingConnectionId = callData.incomingConnectionId;
    }

    // Always update call reference to the latest call
    if (callData.engine === 'elevenlabs-twilio') {
      updates.callId = callData.id;
    } else if (callData.engine === 'plivo-openai') {
      updates.plivoCallId = callData.id;
    } else if (callData.engine === 'twilio-openai') {
      updates.twilioOpenaiCallId = callData.id;
    } else if (callData.engine === 'elevenlabs-sip' || callData.engine === 'openai-sip') {
      updates.sipCallId = callData.id;
    } else if (callData.engine === 'custom-voice-engine') {
      updates.veSessionId = callData.id;
    }

    // Always increment total calls and update last call timestamp
    updates.totalCalls = (existingLead.totalCalls || 0) + 1;
    updates.lastCallAt = new Date();

    return CRMStorage.updateLead(existingLead.id, callData.userId, updates);
  }

  /**
   * Generate suggested next action based on qualification
   */
  private static generateNextAction(qualification: LeadQualification): string {
    if (qualification.hasAppointment) {
      return 'Confirm appointment details and send reminder';
    }
    if (qualification.hasFormSubmission) {
      return 'Review submitted form data and follow up';
    }
    if (qualification.hasTransfer) {
      return 'Review call transfer outcome with agent';
    }
    if (qualification.hasCallback) {
      return 'Schedule follow-up call';
    }
    if (qualification.category === AI_LEAD_CATEGORIES.HOT) {
      return 'High priority - contact immediately';
    }
    if (qualification.category === AI_LEAD_CATEGORIES.WARM) {
      return 'Nurture lead with relevant content';
    }
    if (qualification.category === AI_LEAD_CATEGORIES.NEUTRAL) {
      return 'Monitor lead engagement and follow up if needed';
    }
    if (qualification.category === AI_LEAD_CATEGORIES.COLD) {
      return 'Low priority - add to re-engagement campaign';
    }
    return 'Review call and determine next steps';
  }

  /**
   * Process a call from the ElevenLabs-Twilio engine (calls table)
   */
  static async processElevenLabsTwilioCall(callId: string): Promise<{ leadId: string | null; qualification: LeadQualification } | null> {
    const [call] = await db
      .select()
      .from(calls)
      .where(eq(calls.id, callId))
      .limit(1);

    if (!call || !call.userId) {
      logger.warn(`${this.LOG_PREFIX} Call not found or no user: ${callId}`);
      return null;
    }

    // Only process completed calls
    if (call.status !== 'completed' && call.status !== 'done') {
      logger.warn(`${this.LOG_PREFIX} Call ${callId} not completed (status: ${call.status})`);
      return null;
    }

    // For ElevenLabs-Twilio, extract aiInsights from metadata if available
    const elevenLabsMetadata = call.metadata as Record<string, unknown> || {};
    const elevenLabsAiInsights = elevenLabsMetadata.aiInsights || this.parseAiSummaryAsInsights(call.aiSummary);

    const callData: CallData = {
      id: call.id,
      userId: call.userId,
      companyId: call.companyId ?? null,
      phoneNumber: call.phoneNumber || '',
      fromNumber: call.fromNumber,
      toNumber: call.toNumber,
      callDirection: call.callDirection as 'incoming' | 'outgoing',
      status: call.status,
      duration: call.duration,
      transcript: call.transcript,
      aiSummary: call.aiSummary,
      sentiment: call.sentiment,
      classification: call.classification,
      wasTransferred: call.wasTransferred || false,
      transferredTo: call.transferredTo,
      campaignId: call.campaignId,
      incomingConnectionId: call.incomingConnectionId,
      metadata: {
        ...elevenLabsMetadata,
        // Also include the dedicated conversation ID column for appointment matching
        ...(call.elevenLabsConversationId ? { elevenLabsConversationId: call.elevenLabsConversationId } : {}),
      },
      aiInsights: elevenLabsAiInsights as Record<string, unknown>,  // ElevenLabs stores insights in metadata
      engine: 'elevenlabs-twilio',
    };

    return this.processCall(callData);
  }

  /**
   * Process a call from the Plivo+OpenAI engine (plivo_calls table)
   */
  static async processPlivoOpenAICall(callId: string): Promise<{ leadId: string | null; qualification: LeadQualification } | null> {
    const [call] = await db
      .select()
      .from(plivoCalls)
      .where(eq(plivoCalls.id, callId))
      .limit(1);

    if (!call || !call.userId) {
      logger.warn(`${this.LOG_PREFIX} Plivo call not found or no user: ${callId}`);
      return null;
    }

    // Only process completed calls
    if (call.status !== 'completed' && call.status !== 'done') {
      logger.warn(`${this.LOG_PREFIX} Plivo call ${callId} not completed (status: ${call.status})`);
      return null;
    }

    // For Plivo+OpenAI, extract aiInsights from metadata if available
    const plivoMetadata = call.metadata as Record<string, unknown> || {};
    const plivoAiInsights = plivoMetadata.aiInsights || this.parseAiSummaryAsInsights(call.aiSummary);

    const callData: CallData = {
      id: call.id,
      userId: call.userId,
      companyId: call.companyId ?? null,
      phoneNumber: call.fromNumber || call.toNumber || '',
      fromNumber: call.fromNumber,
      toNumber: call.toNumber,
      callDirection: call.callDirection as 'incoming' | 'outgoing',
      status: call.status,
      duration: call.duration,
      transcript: call.transcript,
      aiSummary: call.aiSummary,
      sentiment: call.sentiment,
      classification: call.classification,
      wasTransferred: call.wasTransferred || false,
      transferredTo: call.transferredTo,
      campaignId: call.campaignId,
      incomingConnectionId: null, // Plivo uses plivoPhoneNumberId instead
      metadata: plivoMetadata,
      aiInsights: plivoAiInsights as Record<string, unknown>,
      engine: 'plivo-openai',
    };

    return this.processCall(callData);
  }

  /**
   * Process a call from the Twilio+OpenAI engine (twilio_openai_calls table)
   */
  static async processTwilioOpenAICall(callId: string): Promise<{ leadId: string | null; qualification: LeadQualification } | null> {
    const [call] = await db
      .select()
      .from(twilioOpenaiCalls)
      .where(eq(twilioOpenaiCalls.id, callId))
      .limit(1);

    if (!call || !call.userId) {
      logger.warn(`${this.LOG_PREFIX} Twilio-OpenAI call not found or no user: ${callId}`);
      return null;
    }

    // Only process completed calls
    if (call.status !== 'completed' && call.status !== 'done') {
      logger.warn(`${this.LOG_PREFIX} Twilio-OpenAI call ${callId} not completed (status: ${call.status})`);
      return null;
    }

    // For Twilio+OpenAI, extract aiInsights from metadata if available
    const twilioMetadata = call.metadata as Record<string, unknown> || {};
    const twilioAiInsights = twilioMetadata.aiInsights || this.parseAiSummaryAsInsights(call.aiSummary);

    const callData: CallData = {
      id: call.id,
      userId: call.userId,
      companyId: call.companyId ?? null,
      phoneNumber: call.fromNumber || call.toNumber || '',
      fromNumber: call.fromNumber,
      toNumber: call.toNumber,
      callDirection: call.callDirection as 'incoming' | 'outgoing',
      status: call.status,
      duration: call.duration,
      transcript: call.transcript,
      aiSummary: call.aiSummary,
      sentiment: call.sentiment,
      classification: call.classification,
      wasTransferred: call.wasTransferred || false,
      transferredTo: call.transferredTo,
      campaignId: call.campaignId,
      incomingConnectionId: null, // Twilio-OpenAI uses twilioPhoneNumberId instead
      metadata: twilioMetadata,
      aiInsights: twilioAiInsights as Record<string, unknown>,
      engine: 'twilio-openai',
    };

    return this.processCall(callData);
  }

  /**
   * Process a call from the SIP engine (sip_calls table)
   */
  static async processSipCall(callId: string): Promise<{ leadId: string | null; qualification: LeadQualification } | null> {
    const [call] = await db
      .select()
      .from(sipCalls)
      .where(eq(sipCalls.id, callId))
      .limit(1);

    if (!call || !call.userId) {
      logger.warn(`${this.LOG_PREFIX} SIP call not found or no user: ${callId}`);
      return null;
    }

    if (call.status !== 'completed' && call.status !== 'done') {
      logger.warn(`${this.LOG_PREFIX} SIP call ${callId} not completed (status: ${call.status})`);
      return null;
    }

    const sipMetadata = call.metadata as Record<string, unknown> || {};
    const sipAiInsights = sipMetadata.aiInsights || this.parseAiSummaryAsInsights(call.aiSummary);

    const callData: CallData = {
      id: call.id,
      userId: call.userId,
      companyId: call.companyId ?? null,
      phoneNumber: call.direction === 'inbound' ? (call.fromNumber || '') : (call.toNumber || ''),
      fromNumber: call.fromNumber,
      toNumber: call.toNumber,
      callDirection: call.direction === 'inbound' ? 'incoming' : 'outgoing',
      status: call.status || 'completed',
      duration: call.durationSeconds,
      transcript: call.transcript ? (typeof call.transcript === 'string' ? call.transcript : JSON.stringify(call.transcript)) : null,
      aiSummary: call.aiSummary,
      sentiment: call.sentiment,
      classification: call.classification,
      wasTransferred: false,
      transferredTo: null,
      campaignId: call.campaignId,
      incomingConnectionId: null,
      metadata: sipMetadata,
      aiInsights: sipAiInsights as Record<string, unknown>,
      engine: call.engine || 'elevenlabs-sip',
    };

    return this.processCall(callData);
  }

  /**
   * Process a call from the Custom Voice Engine (ve_sessions table)
   */
  static async processCustomVoiceEngineCall(sessionId: string): Promise<{ leadId: string | null; qualification: LeadQualification } | null> {
    try {
      const result = await db.execute(sql`
        SELECT * FROM ve_sessions WHERE id = ${sessionId} LIMIT 1
      `);
      const call = (result.rows as any[])[0];

      if (!call || !call.user_id) {
        logger.warn(`${this.LOG_PREFIX} Custom Voice Engine session not found or no user: ${sessionId}`);
        return null;
      }

      // Only process completed calls
      if (call.status !== 'completed' && call.status !== 'done') {
        logger.warn(`${this.LOG_PREFIX} Custom Voice Engine session ${sessionId} not completed (status: ${call.status})`);
        return null;
      }

      const metadata = (typeof call.metadata === 'string' ? JSON.parse(call.metadata) : call.metadata) || {};

      // Parse transcript and build clean text transcript for LLM
      const turns = typeof call.transcript === 'string' 
        ? JSON.parse(call.transcript) 
        : (call.transcript || []);
      const transcriptText = Array.isArray(turns)
        ? turns.map((t: any) => `${t.role === 'assistant' ? 'Agent' : 'Customer'}: ${t.content || t.message || ''}`).join('\n')
        : '';

      let aiSummary = call.ai_summary;
      let sentiment = call.sentiment;
      let classification = call.classification;
      let extractedFirstName = null;
      let extractedLastName = null;
      let extractedEmail = null;
      let extractedCompany = null;

      if (transcriptText.trim().length > 0) {
        try {
          const dbApiKey = await db.execute(sql`
            SELECT value FROM global_settings WHERE key = 'openai_api_key' LIMIT 1
          `);
          const apiKey = (dbApiKey.rows[0]?.value as string) || process.env.OPENAI_API_KEY;

          if (apiKey) {
            const { default: OpenAI } = await import('openai');
            const openai = new OpenAI({ apiKey });

            const prompt = `You are an AI assistant analyzing a call transcript between an agent and a customer.
Analyze the transcript and extract the following details.

TRANSCRIPT:
${transcriptText}

Respond ONLY with a valid JSON object in this exact format:
{
  "summary": "2-3 sentence summary of the call",
  "sentiment": "positive" | "neutral" | "negative",
  "classification": "hot" | "warm" | "cold" | "lost",
  "extractedFirstName": "extracted customer first name or null if not mentioned",
  "extractedLastName": "extracted customer last name or null if not mentioned",
  "extractedEmail": "extracted customer email address or null if not mentioned",
  "extractedCompany": "extracted customer company name or null if not mentioned"
}

Classification Guide:
- "hot": Customer showed strong interest, ready to buy/proceed
- "warm": Customer showed moderate interest, needs follow-up
- "cold": Customer showed little interest, unlikely to convert
- "lost": Customer explicitly declined or hung up early

Return ONLY the JSON object. No explanation, no markdown formatting.`;

            const response = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [{ role: 'user', content: prompt }],
              response_format: { type: 'json_object' },
              temperature: 0.2,
              max_tokens: 500,
            });

            const content = response.choices[0]?.message?.content;
            if (content) {
              const result = JSON.parse(content);
              aiSummary = result.summary || aiSummary;
              sentiment = result.sentiment || sentiment;
              classification = result.classification || classification;
              extractedFirstName = result.extractedFirstName || null;
              extractedLastName = result.extractedLastName || null;
              extractedEmail = result.extractedEmail || null;
              extractedCompany = result.extractedCompany || null;

              logger.info(`💼 [CRM Lead Processor] Extracted call details: Summary="${aiSummary}", Classification="${classification}", Company="${extractedCompany}"`);
            }
          }
        } catch (err: any) {
          console.error('💼 [CRM Lead Processor] Error analyzing transcript with OpenAI:', err.message);
        }
      }

      // Update ve_sessions in the database with the AI analysis results
      if (aiSummary !== call.ai_summary || sentiment !== call.sentiment || classification !== call.classification) {
        try {
          await db.execute(sql`
            UPDATE ve_sessions
            SET ai_summary = ${aiSummary},
                sentiment = ${sentiment},
                classification = ${classification},
                updated_at = NOW()
            WHERE id = ${sessionId}
          `);
        } catch (updateErr: any) {
          console.error('💼 [CRM Lead Processor] Failed to update ve_sessions with AI analysis:', updateErr.message);
        }
      }

      const aiInsights = metadata.aiInsights || this.parseAiSummaryAsInsights(aiSummary);

      const callData: CallData = {
        id: call.id,
        userId: call.user_id,
        companyId: call.company_id ?? null,
        phoneNumber: call.direction === 'inbound' ? (call.from_number || '') : (call.to_number || ''),
        fromNumber: call.from_number,
        toNumber: call.to_number,
        callDirection: call.direction === 'inbound' ? 'incoming' : 'outgoing',
        status: call.status || 'completed',
        duration: call.duration_seconds,
        transcript: call.transcript ? (typeof call.transcript === 'string' ? call.transcript : JSON.stringify(call.transcript)) : null,
        aiSummary: aiSummary,
        sentiment: sentiment,
        classification: classification,
        firstName: extractedFirstName,
        lastName: extractedLastName,
        email: extractedEmail,
        company: extractedCompany,
        wasTransferred: false,
        transferredTo: null,
        campaignId: null,
        incomingConnectionId: null,
        metadata,
        aiInsights: aiInsights as Record<string, unknown>,
        engine: 'custom-voice-engine',
      };

      return this.processCall(callData);
    } catch (error: any) {
      console.error(`${this.LOG_PREFIX} Error processing Custom Voice Engine session ${sessionId}:`, error.message);
      return null;
    }
  }

  /**
   * Parse AI summary as insights if it's a JSON string
   */
  private static parseAiSummaryAsInsights(aiSummary: string | null): Record<string, unknown> | null {
    if (!aiSummary) return null;
    
    try {
      // Check if aiSummary is JSON (sometimes it's stored as stringified JSON)
      const parsed = JSON.parse(aiSummary);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    } catch {
      // Not JSON: the summary is plain text, so there are no structured insights (null is returned below).
    }
    
    return null;
  }

  /**
   * Update the call record's classification in the database to align with the CRM lead category.
   */
  private static async updateCallClassification(callId: string, engine: string, category: string): Promise<void> {
    try {
      logger.info(`[CRM Lead Processor] Updating call classification for call ${callId} to: ${category} (engine: ${engine})`);
      if (engine === 'elevenlabs-twilio') {
        await db
          .update(calls)
          .set({ classification: category })
          .where(eq(calls.id, callId));
      } else if (engine === 'plivo-openai') {
        await db
          .update(plivoCalls)
          .set({ classification: category })
          .where(eq(plivoCalls.id, callId));
      } else if (engine === 'twilio-openai') {
        await db
          .update(twilioOpenaiCalls)
          .set({ classification: category })
          .where(eq(twilioOpenaiCalls.id, callId));
      } else if (engine === 'elevenlabs-sip' || engine === 'openai-sip') {
        await db
          .update(sipCalls)
          .set({ classification: category })
          .where(eq(sipCalls.id, callId));
      } else if (engine === 'custom-voice-engine') {
        await db.execute(sql`
          UPDATE ve_sessions
          SET classification = ${category}
          WHERE id = ${callId}
        `);
      }
    } catch (error) {
      console.error(`[CRM Lead Processor] Failed to update call classification for call ${callId}:`, error);
    }
  }
}

export default CRMLeadProcessor;
