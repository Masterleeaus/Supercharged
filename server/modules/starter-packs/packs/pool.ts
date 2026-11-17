// Pool servicing starter pack (#362). Agent roles come from the workforce catalogue (pool-*).
// Services follow the pool vertical: routine service, chemistry, equipment faults and openings.
// No prices: the company sets its own rates.
import type { Pack } from '../pack.schema.ts';

export const poolPack: Pack = {
  id: 'pool-starter',
  version: 1,
  name: 'Pool servicing starter',
  vertical: 'pool',
  description: 'Enquiry to quote for pool and spa servicing, equipment faults and openings, with a service reminder.',
  agentRoles: [
    'pool-enquiry-reception',
    'pool-booking-coordinator',
    'pool-service-scheduler',
    'pool-water-testing-scheduler',
    'pool-equipment-fault-intake',
    'pool-customer-care',
  ],
  leadQuestions: [
    { id: 'service-type', prompt: 'Is this routine servicing, a fault, or an opening or closing?', field: 'service_type', required: true },
    { id: 'pool-kind', prompt: 'Is it a pool, a spa, or both?', field: 'pool_kind', required: true },
    { id: 'pool-size', prompt: 'About how many litres or square metres is the pool?', field: 'size_sqm', required: false },
    { id: 'suburb', prompt: 'Which suburb is the pool in?', field: 'suburb', required: true },
    { id: 'fault-detail', prompt: 'If something is faulty, what is happening?', field: 'fault_detail', required: false },
    { id: 'frequency', prompt: 'Would you like a regular service plan?', field: 'frequency', required: false },
  ],
  quoteFields: [
    { key: 'service_type', label: 'Type of visit', type: 'select', required: true, options: ['routine', 'fault', 'opening_closing'] },
    { key: 'pool_kind', label: 'Pool or spa', type: 'select', required: true, options: ['pool', 'spa', 'both'] },
    { key: 'size_sqm', label: 'Size (square metres)', type: 'number', required: false },
    { key: 'suburb', label: 'Suburb', type: 'text', required: true },
    { key: 'fault_detail', label: 'Fault detail', type: 'text', required: false },
    { key: 'frequency', label: 'Frequency', type: 'select', required: false, options: ['one_off', 'weekly', 'fortnightly', 'monthly'] },
  ],
  services: [
    { id: 'routine-service', name: 'Routine pool service', pricingUnit: 'visit', quoteFieldKeys: ['service_type', 'pool_kind', 'size_sqm', 'frequency'] },
    { id: 'equipment-diagnosis', name: 'Equipment fault diagnosis', pricingUnit: 'hour', quoteFieldKeys: ['service_type', 'fault_detail', 'suburb'] },
    { id: 'pool-opening-closing', name: 'Pool opening or closing', pricingUnit: 'job', quoteFieldKeys: ['service_type', 'pool_kind', 'size_sqm'] },
    { id: 'monthly-service-plan', name: 'Monthly service plan', pricingUnit: 'month', quoteFieldKeys: ['pool_kind', 'size_sqm', 'frequency'] },
  ],
  messageTemplates: [
    {
      id: 'pool-enquiry-ack',
      purpose: 'enquiry_ack',
      channel: 'email',
      subject: 'Thanks for your enquiry',
      body: 'Hi {{clientName}}, thanks for contacting {{companyName}} about {{serviceName}}. We will confirm your quote shortly.',
    },
    {
      id: 'pool-visit-reminder',
      purpose: 'visit_reminder',
      channel: 'sms',
      subject: null,
      body: 'Hi {{clientName}}, a reminder that {{companyName}} is booked to service your pool at {{visitTime}}.',
    },
  ],
  connectorPresets: [
    { connectorId: 'email', purpose: 'Send enquiry acknowledgements and quotes', required: true },
    { connectorId: 'sms', purpose: 'Visit reminders', required: false },
    { connectorId: 'google_calendar', purpose: 'Schedule regular visits', required: false },
  ],
  compliance: {
    text: [
      'Visit reminders and service offers go only to clients who have opted in.',
      'Every message includes a way to opt out.',
      'Quiet hours apply in the client timezone.',
    ],
    marketingNeedsOptIn: true,
  },
  fixture: {
    demoCompanyName: 'Demo Pool Services',
    timezone: 'Australia/Melbourne',
    enquiry: {
      serviceId: 'equipment-diagnosis',
      answers: { service_type: 'fault', pool_kind: 'pool', fault_detail: 'Pump is humming but not running', suburb: 'Carnegie' },
    },
  },
};
