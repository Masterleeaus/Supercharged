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
import { Request, Response } from 'express';
import { db } from '../../db';
import { calls, contacts, agents, flows } from '../../../shared/schema';
import { nanoid } from 'nanoid';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { webhookDeliveryService } from '../../services/webhook-delivery';
import { validateFormWebhookToken, sanitizeFieldId } from '../../services/form-elevenlabs-tool';
import { findCallForWebhook } from '../../services/call-matcher';

/**
 * Form Submission Tool Webhook Handler
 * 
 * This endpoint is called by ElevenLabs when a Flow Agent uses the submit_form tool.
 * It saves the form submission to the database.
 * 
 * Security: Validates token via URL path
 * 
 * Endpoint: POST /api/webhooks/elevenlabs/form/:token/:formId/:elevenLabsAgentId
 */
export async function handleFormSubmissionWebhook(req: Request, res: Response) {
  const { token: urlToken, formId, agentId: elevenLabsAgentId } = req.params;
  const { callId } = req.query;

  logger.info(`📋 [Form Webhook] Received submission for form: ${formId}, agent: ${elevenLabsAgentId}`);

  try {
    const { formSubmissions, forms, formFields } = await import('../../../shared/schema');

    if (!validateFormWebhookToken(urlToken)) {
      logger.warn(`📋 [Form Webhook] Invalid authentication token`);
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Invalid authentication token"
      });
    }

    logger.info(`📋 [Form Webhook] Authentication successful`);
    logger.info(`   Request body:`);

    const { contactName, contactPhone, ...fieldResponses } = req.body;

    // Look up agent by ElevenLabs agent ID to get database agent ID and userId
    const agent = await db
      .select({ id: agents.id, userId: agents.userId, companyId: agents.companyId, flowId: agents.flowId })
      .from(agents)
      .where(eq(agents.elevenLabsAgentId, elevenLabsAgentId))
      .limit(1);

    if (agent.length === 0) {
      logger.warn(`📋 [Form Webhook] No agent found with ElevenLabs ID ${elevenLabsAgentId}`);
      return res.json({
        success: false,
        message: "Could not find the agent to submit the form."
      });
    }

    const userId = agent[0].userId;
    // Note: agent.flowId is the flow template ID, not a flow execution ID
    // We set flowExecutionId to null since we don't have the execution ID in webhook context
    // The callId still provides traceability to the specific call

    logger.info(`📋 [Form Webhook] Found database agent for user ${userId}`);

    // Verify form exists and belongs to user
    const [form] = await db
      .select()
      .from(forms)
      .where(and(eq(forms.id, formId), eq(forms.userId, userId)))
      .limit(1);

    if (!form) {
      logger.warn(`📋 [Form Webhook] Form ${formId} not found for user ${userId}`);
      return res.json({
        success: false,
        message: "Could not find the form to submit."
      });
    }

    // Provider webhooks carry no session, so company comes from the owning form record.
    // Fail closed: refuse rather than insert a submission without company_id.
    const submissionCompanyId: string | null = form.companyId ?? null;
    if (!submissionCompanyId) {
      logger.warn(`📋 [Form Webhook] Refusing submission insert: form ${formId} has no company_id`);
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    // Get form fields for response mapping
    const fields = await db
      .select()
      .from(formFields)
      .where(eq(formFields.formId, formId))
      .orderBy(formFields.order);

    // Build responses array from field responses
    const responses: { fieldId: string; question: string; answer: string }[] = [];

    for (const field of fields) {
      // Use sanitized field ID to match the webhook schema (hyphens → underscores)
      const fieldKey = `field_${sanitizeFieldId(field.id)}`;
      if (fieldResponses[fieldKey] !== undefined) {
        responses.push({
          fieldId: field.id,
          question: field.question,
          answer: String(fieldResponses[fieldKey])
        });
      }
    }

    // If contactPhone was not supplied (e.g. form has a dedicated phone/tel field and
    // contactPhone was not marked required in the schema), resolve it from the field response
    // BEFORE the call matcher runs so the matcher can use the resolved phone for lookup.
    let resolvedContactPhone = contactPhone;
    if (!resolvedContactPhone) {
      const phoneField = fields.find((f: any) => f.fieldType === 'phone' || f.fieldType === 'tel');
      if (phoneField) {
        const phoneKey = `field_${sanitizeFieldId(phoneField.id)}`;
        if (fieldResponses[phoneKey]) {
          resolvedContactPhone = String(fieldResponses[phoneKey]);
          logger.info(`📋 [Form Webhook] Extracted contactPhone from phone field "${phoneField.id}": [redacted]`);
        }
      }
    }

    // Get verified caller info from call record
    // Strategy: Try explicit callId first, then use call matcher to find recent calls for this agent
    let validatedCallId: string | null = null;
    let verifiedCallerPhone: string | null = null;
    let verifiedCallerName: string | null = null;

    // Try explicit callId if provided (legacy support)
    if (callId) {
      const callRecord = await db
        .select({
          id: calls.id,
          userId: calls.userId,
          phoneNumber: calls.phoneNumber,
          contactId: calls.contactId
        })
        .from(calls)
        .where(and(
          eq(calls.id, callId as string),
          eq(calls.userId, userId)
        ))
        .limit(1);

      if (callRecord.length > 0) {
        validatedCallId = callRecord[0].id;
        verifiedCallerPhone = callRecord[0].phoneNumber;

        if (callRecord[0].contactId) {
          const contactRecord = await db
            .select({
              firstName: contacts.firstName,
              lastName: contacts.lastName,
              phone: contacts.phone
            })
            .from(contacts)
            .where(eq(contacts.id, callRecord[0].contactId))
            .limit(1);
          if (contactRecord.length > 0) {
            verifiedCallerName = [contactRecord[0].firstName, contactRecord[0].lastName].filter(Boolean).join(' ');
            verifiedCallerPhone = contactRecord[0].phone || verifiedCallerPhone;
          }
        }
        logger.info(`📋 [Form Webhook] Found call by explicit ID: ${validatedCallId}`);
      }
    }

    // If no explicit callId, use call matcher to find recent calls for this agent/phone
    // Pass resolvedContactPhone (which includes phone-field fallback) for better matching
    if (!validatedCallId) {
      const matchedCall = await findCallForWebhook(elevenLabsAgentId, resolvedContactPhone, userId);

      if (matchedCall) {
        validatedCallId = matchedCall.callId;
        verifiedCallerPhone = matchedCall.verifiedContactPhone || matchedCall.phoneNumber;
        verifiedCallerName = matchedCall.contactName;
        logger.info(`📋 [Form Webhook] Matched call via call-matcher: ${validatedCallId}`);
      } else {
        logger.info(`📋 [Form Webhook] No call match found - submission will be saved without call link`);
      }
    }

    const finalContactPhone = verifiedCallerPhone || resolvedContactPhone || null;
    const finalContactName = verifiedCallerName || contactName || 'Unknown Caller';

    // Create form submission
    const submissionId = nanoid();
    const [newSubmission] = await db
      .insert(formSubmissions)
      .values({
        id: submissionId,
        companyId: submissionCompanyId,
        formId,
        callId: validatedCallId,
        flowExecutionId: null, // Set to null - we don't have execution ID in webhook context
        contactName: finalContactName,
        contactPhone: finalContactPhone,
        responses,
      })
      .returning();

    logger.info(`📋 [Form Webhook] Created submission ${submissionId}`);
    logger.info(`   Contact: ${finalContactName} ([redacted])`);
    logger.info(`   Responses: ${responses.length} fields`);

    // Push form data to Google Sheets if the flow node has a sheet configured
    try {
      const agentFlowId = agent[0].flowId;
      if (agentFlowId) {
        const [flowRecord] = await db
          .select({ nodes: flows.nodes })
          .from(flows)
          .where(eq(flows.id, agentFlowId))
          .limit(1);

        if (flowRecord) {
          const flowNodes: any[] = (flowRecord.nodes as any[]) || [];

          // Try to match the exact flow node using nodeId (passed as query param from the webhook URL).
          // This avoids picking the wrong node when the same formId is used in multiple branches.
          const incomingNodeId = req.query.nodeId as string | undefined;
          let formFlowNode: any = undefined;

          if (incomingNodeId) {
            // Match by nodeId AND verify the node's formId matches — prevents misrouted sheet config
            // when a stale/spoofed nodeId points to a different form node in the same flow.
            const candidate = flowNodes.find((n: any) => n.id === incomingNodeId);
            if (candidate) {
              const candidateCfg = candidate.data?.config || candidate.data || {};
              if (candidateCfg.formId === formId) {
                formFlowNode = candidate;
                logger.info(`📋 [Form Webhook] Matched flow node by nodeId ${incomingNodeId} + formId ${formId}`);
              } else {
                logger.warn(
                  `📋 [Form Webhook] nodeId "${incomingNodeId}" found but formId mismatch ` +
                  `(node has "${candidateCfg.formId}", expected "${formId}") — falling back to formId match`
                );
              }
            } else {
              logger.warn(`📋 [Form Webhook] nodeId "${incomingNodeId}" not found in flow; falling back to formId match`);
            }
          }

          // Fallback: match by formId (backward-compat with agents that have no nodeId in URL)
          if (!formFlowNode) {
            formFlowNode = flowNodes.find((n: any) => {
              const cfg = n.data?.config || n.data || {};
              return cfg.formId === formId;
            });
            if (formFlowNode) {
              logger.info(`📋 [Form Webhook] Matched flow node by formId (fallback)`);
            }
          }

          if (formFlowNode) {
            const cfg = formFlowNode.data?.config || formFlowNode.data || {};
            const sheetId: string | undefined = cfg.googleSheetId;
            let sheetName: string = cfg.googleSheetName || '';

            if (sheetId) {
              const { appendRowToSheet, listSheetTabs, ensureSheetHeaders } = await import('../../services/google-sheets/google-sheets.service');

              // When no tab name is configured, detect the first tab dynamically.
              // This prevents silent failures when the spreadsheet doesn't have a "Sheet1" tab.
              if (!sheetName) {
                try {
                  const tabs = await listSheetTabs(userId, sheetId);
                  if (tabs.length > 0) {
                    sheetName = tabs[0].title;
                    logger.info(`📋 [Form Webhook] Auto-detected sheet tab: "${sheetName}"`);
                  } else {
                    sheetName = 'Sheet1'; // absolute last-resort fallback
                    logger.warn(`📋 [Form Webhook] Could not detect sheet tabs; falling back to "Sheet1"`);
                  }
                } catch (tabErr: any) {
                  sheetName = 'Sheet1';
                  logger.warn(`📋 [Form Webhook] Tab detection failed (${tabErr.message}); falling back to "Sheet1"`);
                }
              }

              // Safety-net: write header row if not already present (in case flow-save didn't run it).
              // responses already carry the question text for each field.
              try {
                const headerRow = [
                  'Contact Name',
                  'Contact Phone',
                  ...responses.map((r: any) => r.question || r.fieldId || ''),
                  'Call ID',
                  'Submitted At',
                ];
                const wroteHeaders = await ensureSheetHeaders(userId, sheetId, sheetName, headerRow);
                if (wroteHeaders) {
                  logger.warn(`📋 [Form Webhook] Safety-net: wrote missing header row to Google Sheet "${sheetName}" (${sheetId})`);
                }
              } catch (headerErr: any) {
                logger.warn(`📋 [Form Webhook] Safety-net header write failed (non-fatal):`, headerErr.message);
              }

              const answerValues = responses.map((r: any) => r.answer ?? '');
              const sheetRow: (string | null)[] = [
                finalContactName,
                finalContactPhone,
                ...answerValues,
                validatedCallId,
                new Date().toISOString(),
              ];
              const pushed = await appendRowToSheet(userId, sheetId, sheetName, sheetRow);
              if (pushed) {
                logger.info(`📋 [Form Webhook] Appended row to Google Sheet "${sheetName}" (${sheetId})`);
              } else {
                const errMsg = `appendRowToSheet returned false for sheet ${sheetId} tab "${sheetName}"`;
                logger.error(`📋 [Form Webhook] Google Sheets append FAILED — form data saved locally but NOT in Google Sheets. ${errMsg}`);
                // Persist a structured warning on the call record so the failure is visible in the UI call log
                if (validatedCallId) {
                  try {
                    const { sql: drizzleSql } = await import('drizzle-orm');
                    const warning = JSON.stringify({
                      googleSheetsWarning: true,
                      googleSheetsSheetId: sheetId,
                      googleSheetsTab: sheetName,
                      googleSheetsErrorMessage: errMsg,
                      googleSheetsErrorAt: new Date().toISOString(),
                    });
                    const callTables = ['calls', 'twilio_openai_calls', 'plivo_calls', 'sip_calls'] as const;
                    for (const table of callTables) {
                      const rows = await db.execute(drizzleSql.raw(`SELECT id FROM ${table} WHERE id = `).append(drizzleSql`${validatedCallId}`).append(drizzleSql.raw(` LIMIT 1`)));
                      if ((Array.isArray(rows) ? rows : (rows as any).rows || []).length > 0) {
                        await db.execute(drizzleSql.raw(`UPDATE ${table} SET metadata = COALESCE(metadata, '{}'::jsonb) || `).append(drizzleSql`${warning}::jsonb`).append(drizzleSql.raw(` WHERE id = `)).append(drizzleSql`${validatedCallId}`));
                        logger.info(`📋 [Form Webhook] Wrote googleSheetsWarning to ${table} call ${validatedCallId}`);
                        break;
                      }
                    }
                  } catch (warnErr: any) {
                    logger.warn(`📋 [Form Webhook] Could not write googleSheetsWarning to call record:`, warnErr.message);
                  }
                }
              }
            }
          } else {
            logger.warn(`📋 [Form Webhook] No matching flow node found for formId ${formId} — Google Sheets push skipped`);
          }
        }
      }
    } catch (sheetError: any) {
      logger.error(`📋 [Form Webhook] Google Sheets push failed (non-fatal):`, sheetError.message);
    }

    // Trigger form.submitted webhook event
    try {
      await webhookDeliveryService.triggerEvent(agent[0].companyId ?? null, userId, 'form.submitted', {
        submission: {
          id: submissionId,
          formId: formId,
          formName: form.name,
          contactName: finalContactName,
          contactPhone: finalContactPhone,
          responses: responses,
          submittedAt: new Date().toISOString(),
        },
        call: {
          id: validatedCallId || null,
        },
        form: {
          id: form.id,
          name: form.name,
          description: form.description || null,
        },
      });
      logger.info(`📋 [Form Webhook] Triggered form.submitted webhook event`);
    } catch (webhookError: any) {
      logger.error(`📋 [Form Webhook] Failed to trigger webhook:`, webhookError.message);
    }

    // Update call metadata for CRM Lead Processor detection
    if (validatedCallId) {
      try {
        const [existingCall] = await db
          .select()
          .from(calls)
          .where(eq(calls.id, validatedCallId))
          .limit(1);

        if (existingCall) {
          const existingMetadata = (existingCall.metadata as Record<string, unknown>) || {};
          const existingAiInsights = (existingMetadata.aiInsights as Record<string, unknown>) || {};

          const updatedMetadata = {
            ...existingMetadata,
            formSubmitted: true,
            hasFormSubmission: true,
            formData: {
              submissionId,
              formId,
              formName: form.name,
              contactName: finalContactName,
              contactPhone: finalContactPhone,
              submittedAt: new Date().toISOString(),
            },
            aiInsights: {
              ...existingAiInsights,
              primaryOutcome: 'form_submitted',
              formSubmitted: true,
            },
          };

          await db
            .update(calls)
            .set({ metadata: updatedMetadata })
            .where(eq(calls.id, validatedCallId));

          logger.info(`📋 [Form Webhook] Updated call metadata for CRM detection`);
        }
      } catch (metadataError: any) {
        logger.error(`📋 [Form Webhook] Failed to update call metadata:`, metadataError.message);
      }
    }

    return res.json({
      success: true,
      message: `Thank you! Your responses have been recorded successfully.`,
      submissionId: submissionId
    });

  } catch (error: any) {
    logger.error(`❌ [Form Webhook] Error:`, error.message);
    return res.json({
      success: false,
      message: "I encountered an error while saving your responses. Please try again."
    });
  }
}
