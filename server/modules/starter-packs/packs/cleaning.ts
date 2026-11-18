// Cleaning starter pack (#362). Agent roles come from the workforce catalogue (cleaning-*).
// Services and questions follow the cleaning verticals (residential #137, office #138, bond and
// end-of-lease #139). No prices: the company sets its own rates.
import type { Pack } from '../pack.schema.ts';

export const cleaningPack: Pack = {
  id: 'cleaning-starter',
  version: 1,
  name: 'Cleaning starter',
  vertical: 'cleaning',
  description: 'Enquiry to quote for residential, end-of-lease and office cleaning, with a review request after the clean.',
  agentRoles: [
    'cleaning-enquiry-reception',
    'cleaning-quote-intake',
    'cleaning-booking-coordinator',
    'cleaning-invoice-query-desk',
    'cleaning-feedback-survey',
    'cleaning-customer-care',
    'cleaning-post-visit-quality-check',
  ],
  leadQuestions: [
    { id: 'service-wanted', prompt: 'What kind of clean do you need: home, end of lease, or office?', field: 'clean_type', required: true },
    { id: 'property-size', prompt: 'Roughly how big is the property, in bedrooms or square metres?', field: 'size_sqm', required: true },
    { id: 'suburb', prompt: 'Which suburb is the property in?', field: 'suburb', required: true },
    { id: 'frequency', prompt: 'One-off, weekly, fortnightly or monthly?', field: 'frequency', required: true },
    { id: 'access', prompt: 'How do we get in, and is anyone home?', field: 'access_notes', required: false },
    { id: 'timing', prompt: 'When would you like it done?', field: 'preferred_timing', required: false },
  ],
  quoteFields: [
    { key: 'clean_type', label: 'Type of clean', type: 'select', required: true, options: ['home', 'end_of_lease', 'office'] },
    { key: 'size_sqm', label: 'Size (square metres)', type: 'number', required: true },
    { key: 'suburb', label: 'Suburb', type: 'text', required: true },
    { key: 'frequency', label: 'Frequency', type: 'select', required: true, options: ['one_off', 'weekly', 'fortnightly', 'monthly'] },
    { key: 'access_notes', label: 'Access notes', type: 'text', required: false },
    { key: 'preferred_timing', label: 'Preferred timing', type: 'text', required: false },
    { key: 'pets_on_site', label: 'Pets on site', type: 'boolean', required: false },
  ],
  services: [
    { id: 'home-clean', name: 'Home clean', pricingUnit: 'visit', quoteFieldKeys: ['clean_type', 'size_sqm', 'frequency', 'access_notes', 'pets_on_site'] },
    { id: 'end-of-lease-clean', name: 'End of lease clean', pricingUnit: 'job', quoteFieldKeys: ['clean_type', 'size_sqm', 'suburb', 'access_notes'] },
    { id: 'office-clean', name: 'Office clean', pricingUnit: 'visit', quoteFieldKeys: ['clean_type', 'size_sqm', 'frequency', 'access_notes'] },
    { id: 'additional-hours', name: 'Extra cleaning hours', pricingUnit: 'hour', quoteFieldKeys: ['preferred_timing', 'access_notes'] },
  ],
  messageTemplates: [
    {
      id: 'cleaning-enquiry-ack',
      purpose: 'enquiry_ack',
      channel: 'email',
      subject: 'Thanks for your enquiry',
      body: 'Hi {{clientName}}, thanks for asking {{companyName}} about a {{serviceName}}. We will confirm your quote shortly.',
    },
    {
      id: 'cleaning-quote-followup',
      purpose: 'quote_followup',
      channel: 'email',
      subject: 'Your cleaning quote',
      body: 'Hi {{clientName}}, following up on your quote from {{companyName}}. Happy to answer any questions.',
    },
    {
      id: 'cleaning-review-request',
      purpose: 'review_request',
      channel: 'sms',
      subject: null,
      body: 'Hi {{clientName}}, thanks for choosing {{companyName}}. If you have a minute, a review helps: {{reviewUrl}}',
    },
  ],
  connectorPresets: [
    { connectorId: 'email', purpose: 'Send enquiry acknowledgements and quotes', required: true },
    { connectorId: 'google_calendar', purpose: 'Book and confirm clean times', required: false },
    { connectorId: 'sms', purpose: 'Visit reminders and review requests', required: false },
  ],
  compliance: {
    text: [
      'Reminders and review requests go only to clients who have opted in.',
      'Every message includes a way to opt out.',
      'Quiet hours apply in the client timezone.',
    ],
    marketingNeedsOptIn: true,
  },
  fixture: {
    demoCompanyName: 'Demo Cleaning Co',
    timezone: 'Australia/Melbourne',
    enquiry: {
      serviceId: 'end-of-lease-clean',
      answers: { clean_type: 'end_of_lease', size_sqm: 85, suburb: 'Brunswick', frequency: 'one_off', access_notes: 'Key with agent', preferred_timing: 'Friday' },
    },
  },
};
