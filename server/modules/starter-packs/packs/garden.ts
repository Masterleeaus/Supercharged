// Garden maintenance starter pack (#362). Agent roles come from the workforce catalogue (garden-*).
// Services follow the garden vertical: mowing, clean-ups, hedge trimming and mulch.
// No prices: the company sets its own rates.
import type { Pack } from '../pack.schema.ts';

export const gardenPack: Pack = {
  id: 'garden-starter',
  version: 1,
  name: 'Garden maintenance starter',
  vertical: 'garden',
  description: 'Enquiry to quote for mowing, clean-ups and hedge work, with a chaser for open quotes and seasonal reminders.',
  agentRoles: [
    'garden-quote-chaser',
    'garden-lawn-mowing-scheduler',
    'garden-seasonal-reminder',
    'garden-job-completion-follow-up',
    'garden-landscape-design-quote-intake',
    'garden-customer-feedback-survey',
  ],
  leadQuestions: [
    { id: 'work-type', prompt: 'What do you need: mowing, a clean-up, hedge trimming, or mulch?', field: 'work_type', required: true },
    { id: 'area', prompt: 'Roughly how big is the garden, in square metres?', field: 'size_sqm', required: true },
    { id: 'suburb', prompt: 'Which suburb is the garden in?', field: 'suburb', required: true },
    { id: 'frequency', prompt: 'One-off, or a regular visit?', field: 'frequency', required: true },
    { id: 'access', prompt: 'Is there gate or water access we should know about?', field: 'access_notes', required: false },
  ],
  quoteFields: [
    { key: 'work_type', label: 'Type of work', type: 'select', required: true, options: ['mowing', 'clean_up', 'hedge_trim', 'mulch'] },
    { key: 'size_sqm', label: 'Area (square metres)', type: 'number', required: true },
    { key: 'suburb', label: 'Suburb', type: 'text', required: true },
    { key: 'frequency', label: 'Frequency', type: 'select', required: true, options: ['one_off', 'weekly', 'fortnightly', 'monthly'] },
    { key: 'access_notes', label: 'Access notes', type: 'text', required: false },
  ],
  services: [
    { id: 'lawn-mowing', name: 'Lawn mowing', pricingUnit: 'visit', quoteFieldKeys: ['work_type', 'size_sqm', 'frequency', 'access_notes'] },
    { id: 'garden-clean-up', name: 'Garden clean-up', pricingUnit: 'job', quoteFieldKeys: ['work_type', 'size_sqm', 'suburb'] },
    { id: 'hedge-trimming', name: 'Hedge trimming', pricingUnit: 'hour', quoteFieldKeys: ['work_type', 'size_sqm', 'access_notes'] },
    { id: 'mulch-supply', name: 'Mulch supply and spread', pricingUnit: 'sqm', quoteFieldKeys: ['work_type', 'size_sqm', 'access_notes'] },
  ],
  messageTemplates: [
    {
      id: 'garden-enquiry-ack',
      purpose: 'enquiry_ack',
      channel: 'email',
      subject: 'Thanks for your enquiry',
      body: 'Hi {{clientName}}, thanks for contacting {{companyName}} about {{serviceName}}. We will send your quote shortly.',
    },
    {
      id: 'garden-quote-chaser',
      purpose: 'quote_followup',
      channel: 'email',
      subject: 'Your garden quote',
      body: 'Hi {{clientName}}, checking you received our garden quote from {{companyName}}. Happy to adjust the scope.',
    },
  ],
  connectorPresets: [
    { connectorId: 'email', purpose: 'Send enquiry acknowledgements and quotes', required: true },
    { connectorId: 'google_calendar', purpose: 'Route mowing and clean-up visits', required: false },
    { connectorId: 'sms', purpose: 'Seasonal reminders', required: false },
  ],
  compliance: {
    text: [
      'Quote chasers and seasonal reminders go only to clients who have opted in.',
      'Every message includes a way to opt out.',
      'Quiet hours apply in the client timezone.',
    ],
    marketingNeedsOptIn: true,
  },
  fixture: {
    demoCompanyName: 'Demo Garden Care',
    timezone: 'Australia/Melbourne',
    enquiry: {
      serviceId: 'lawn-mowing',
      answers: { work_type: 'mowing', size_sqm: 300, suburb: 'Kew', frequency: 'fortnightly', access_notes: 'Side gate, code 1234' },
    },
  },
};
