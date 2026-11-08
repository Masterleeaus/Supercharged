/**
 * Desk-owned shadow template governance. A wire schema permits syntactically
 * valid template names, but does not confer permission to use those templates.
 * This policy intentionally does not enable provider delivery.
 */
import { BridgeProtocolError } from './protocol.mjs';
const RULES = Object.freeze({
  job_reminder: Object.freeze({channel:'sms', resources:['visit','job'], kind:'operational'}),
  job_update: Object.freeze({channel:'sms', resources:['job'], kind:'operational'}),
  booking_confirmation: Object.freeze({channel:'sms', resources:['visit'], kind:'operational'}),
  estimate_followup: Object.freeze({channel:'sms', resources:['estimate'], kind:'customer_followup'}),
  invoice_followup: Object.freeze({channel:'sms', resources:['invoice'], kind:'financial_sensitive'}),
});
export function approvedShadowTemplates() {
  return Object.keys(RULES).sort();
}
export function assertShadowTemplatePolicy(intent) {
  const rule = RULES[intent?.template_key];
  if (!rule) throw new BridgeProtocolError('template_not_approved',422);
  if (intent.channel !== rule.channel || !rule.resources.includes(intent.resource?.kind))
    throw new BridgeProtocolError('template_resource_channel_mismatch',422);
  // External provider dispatch remains impossible here, including for a valid template.
  return Object.freeze({template_key:intent.template_key,kind:rule.kind,shadow_only:true});
}
