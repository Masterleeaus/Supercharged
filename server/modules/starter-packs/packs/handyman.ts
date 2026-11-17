// Handyman starter pack (#362). Agent roles come from the workforce catalogue (handyman-*).
// Services follow the handyman vertical: callouts, small repairs and fixture installs.
// No prices: the company sets its own rates.
import type { Pack } from '../pack.schema.ts';

export const handymanPack: Pack = {
  id: 'handyman-starter',
  version: 1,
  name: 'Handyman starter',
  vertical: 'handyman',
  description: 'Enquiry to quote for small repairs, installs and callouts, with a warranty check-in after the job.',
  agentRoles: ['handyman-job-scoping', 'handyman-warranty-callback'],
  leadQuestions: [
    { id: 'job-type', prompt: 'What needs doing: a repair, an install, or a general callout?', field: 'job_type', required: true },
    { id: 'job-description', prompt: 'Describe the job in a sentence or two.', field: 'job_description', required: true },
    { id: 'suburb', prompt: 'Which suburb is the job in?', field: 'suburb', required: true },
    { id: 'photos', prompt: 'Can you send a photo of the problem or the spot?', field: 'has_photos', required: false },
    { id: 'timing', prompt: 'When would suit you?', field: 'preferred_timing', required: false },
  ],
  quoteFields: [
    { key: 'job_type', label: 'Type of work', type: 'select', required: true, options: ['repair', 'install', 'callout'] },
    { key: 'job_description', label: 'Description', type: 'text', required: true },
    { key: 'suburb', label: 'Suburb', type: 'text', required: true },
    { key: 'estimated_hours', label: 'Estimated hours', type: 'number', required: false },
    { key: 'has_photos', label: 'Photos received', type: 'boolean', required: false },
    { key: 'preferred_timing', label: 'Preferred timing', type: 'text', required: false },
  ],
  services: [
    { id: 'hourly-callout', name: 'Hourly callout', pricingUnit: 'hour', quoteFieldKeys: ['job_type', 'job_description', 'estimated_hours'] },
    { id: 'small-repair', name: 'Small repair', pricingUnit: 'job', quoteFieldKeys: ['job_type', 'job_description', 'has_photos'] },
    { id: 'fixture-install', name: 'Fixture install', pricingUnit: 'each', quoteFieldKeys: ['job_type', 'job_description', 'suburb'] },
  ],
  messageTemplates: [
    {
      id: 'handyman-enquiry-ack',
      purpose: 'enquiry_ack',
      channel: 'email',
      subject: 'Thanks for your enquiry',
      body: 'Hi {{clientName}}, thanks for contacting {{companyName}} about your {{serviceName}}. We will be in touch with a quote.',
    },
    {
      id: 'handyman-quote-followup',
      purpose: 'quote_followup',
      channel: 'sms',
      subject: null,
      body: 'Hi {{clientName}}, checking you received our quote from {{companyName}}. Reply with any questions.',
    },
  ],
  connectorPresets: [
    { connectorId: 'email', purpose: 'Send enquiry acknowledgements and quotes', required: true },
    { connectorId: 'sms', purpose: 'Quote follow-ups', required: false },
    { connectorId: 'google_calendar', purpose: 'Book callouts', required: false },
  ],
  compliance: {
    text: [
      'Quote follow-ups go only to clients who have opted in.',
      'Every message includes a way to opt out.',
      'Quiet hours apply in the client timezone.',
    ],
    marketingNeedsOptIn: true,
  },
  fixture: {
    demoCompanyName: 'Demo Handyman Co',
    timezone: 'Australia/Melbourne',
    enquiry: {
      serviceId: 'small-repair',
      answers: { job_type: 'repair', job_description: 'Leaking kitchen tap', suburb: 'Footscray', has_photos: true, preferred_timing: 'Next week' },
    },
  },
};
