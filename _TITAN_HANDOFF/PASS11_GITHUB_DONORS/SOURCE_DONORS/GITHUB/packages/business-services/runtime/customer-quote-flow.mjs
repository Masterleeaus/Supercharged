import { createSalesStructuredHandoff } from '../../packages/titan-platform/src/ported/titan-workforce/starter-agents/sales/runtime/sales-structured-handoff.js';
import { buildJobsHandoff } from '../../packages/titan-platform/src/ported/titan-workforce/starter-agents/booking/booking-handoffs.js';
import { compileJobCreationContext, dedupeJobCreation } from '../../titan-workforce/starter-agents/jobs/jobs-context-bridge.mjs';
import { evaluateJobCompletionReadiness } from '../../titan-workforce/starter-agents/jobs/jobs-completion-readiness.mjs';
import { buildWorkforceScheduleRecurrence, evaluateWorkforceScheduleDue } from '../../titan-workforce/scheduling/workforce-schedule-recurrence-runtime.mjs';
import { normalizeCalendarEvent } from '../../packages/titan-platform/src/ported/titan-workforce/starter-agents/booking/calendar-reconciliation.js';
import { classifyJobException, planExceptionResolution } from '../../titan-workforce/starter-agents/jobs/jobs-exception-runtime.mjs';

export const CUSTOMER_QUOTE_FLOW_SCHEMA = 'titan.business.customer-quote-flow.v1';

const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

function rejectLegacyBoundary(input, label = 'customer-quote-flow') {
  if (!input || typeof input !== 'object') return;
  for (const key of ['tenant_id', 'tenant_company_id']) {
    if (key in input) throw new TypeError(`${label} rejects legacy tenant boundaries`);
  }
}

function assertCompany(companyId, value, label) {
  rejectLegacyBoundary(value, label);
  const nested = clean(value?.company_id);
  if (nested && nested !== companyId) throw new TypeError(`cross-company ${label} rejected`);
}

function refs(input, customerId = null) {
  return Object.freeze({
    company_id: clean(input.company_id),
    lead_id: clean(input.lead_id),
    opportunity_id: clean(input.opportunity_id),
    customer_id: customerId,
    correlation_id: clean(input.correlation_id),
    journey_id: clean(input.journey_id ?? input.interaction_context?.journey_id),
    conversation_id: clean(input.interaction_context?.conversation_id),
  });
}

export function planCustomerToQuote(input = {}) {
  rejectLegacyBoundary(input);
  const companyId = clean(input.company_id);
  if (!companyId) throw new TypeError('company_id is required');
  const leadId = clean(input.lead_id);
  if (!leadId) throw new TypeError('lead_id is required');
  const correlationId = clean(input.correlation_id);
  if (!correlationId) throw new TypeError('correlation_id is required');

  for (const [label, value] of Object.entries({
    customer_context: input.customer_context,
    service_context: input.service_context,
    interaction_context: input.interaction_context,
    duplicate_check: input.duplicate_check,
  })) assertCompany(companyId, value, label);

  const customerId = clean(input.customer_id ?? input.customer_context?.customer_id);
  const continuity = refs(input, customerId);

  if (!customerId) {
    return Object.freeze({
      schema: CUSTOMER_QUOTE_FLOW_SCHEMA,
      company_id: companyId,
      state: 'customer_required',
      next: Object.freeze({
        workflow: Object.freeze({
          path: 'titan-business-services/workflows/new_customer.json',
          capability: 'crm.customer.create',
        }),
        purpose: 'create_or_resolve_canonical_customer_before_quote',
        continuation: Object.freeze({
          workflow: Object.freeze({
            path: 'titan-business-services/workflows/create_quote.json',
            capability: 'crm.quote.create',
          }),
          required_output: 'customer_id',
          preserve_refs: continuity,
        }),
      }),
      continuity,
      restrictions: Object.freeze({
        customer_creation_performed: false,
        quote_creation_performed: false,
        crm_mutation_performed: false,
        downstream_completion_inferred: false,
      }),
      authority_neutral: true,
      execution_authority: false,
    });
  }

  const quote = createSalesStructuredHandoff({
    ...input,
    target: 'quote',
    customer_id: customerId,
  });

  return Object.freeze({
    schema: CUSTOMER_QUOTE_FLOW_SCHEMA,
    company_id: companyId,
    state: quote.disposition === 'duplicate_suppressed' ? 'quote_duplicate_suppressed' : 'quote_ready',
    next: quote,
    continuity,
    restrictions: Object.freeze({
      customer_creation_performed: false,
      quote_creation_performed: false,
      crm_mutation_performed: false,
      downstream_completion_inferred: false,
    }),
    authority_neutral: true,
    execution_authority: false,
  });
}

export const QUOTE_BOOKING_FLOW_SCHEMA = 'titan.business.quote-booking-flow.v1';
export const BOOKING_SCHEDULING_FLOW_SCHEMA = 'titan.business.booking-scheduling-flow.v1';

function acceptedQuoteStatus(value) {
  return clean(value)?.toLowerCase() === 'accepted';
}

function confirmedBookingStatus(value) {
  return ['confirmed', 'accepted'].includes(clean(value)?.toLowerCase());
}

export function planAcceptedQuoteToBooking(input = {}) {
  rejectLegacyBoundary(input, 'quote-booking-flow');
  const companyId = clean(input.company_id);
  const quoteId = clean(input.quote_id ?? input.quote_ref);
  const customerId = clean(input.customer_id ?? input.customer_context?.customer_id);
  const correlationId = clean(input.correlation_id);
  if (!companyId) throw new TypeError('company_id is required');
  if (!quoteId) throw new TypeError('quote_id is required');
  if (!customerId) throw new TypeError('customer_id is required');
  if (!correlationId) throw new TypeError('correlation_id is required');
  if (!acceptedQuoteStatus(input.quote_status)) throw new TypeError('accepted quote is required before booking handoff');

  for (const [label, value] of Object.entries({
    quote_context: input.quote_context,
    customer_context: input.customer_context,
    service_context: input.service_context,
    booking_context: input.booking_context,
    interaction_context: input.interaction_context,
    duplicate_check: input.duplicate_check,
  })) assertCompany(companyId, value, label);

  if (input.duplicate_check?.checked !== true || !clean(input.duplicate_check?.source_ref)) {
    throw new TypeError('authoritative duplicate booking check with source_ref is required');
  }

  const continuity = Object.freeze({
    company_id: companyId,
    quote_ref: quoteId,
    customer_id: customerId,
    lead_id: clean(input.lead_id),
    opportunity_id: clean(input.opportunity_id),
    correlation_id: correlationId,
    journey_id: clean(input.journey_id ?? input.interaction_context?.journey_id),
    conversation_id: clean(input.interaction_context?.conversation_id),
  });

  const booking = createSalesStructuredHandoff({
    ...input,
    target: 'booking',
    quote_id: quoteId,
    customer_id: customerId,
    lead_id: clean(input.lead_id) ?? `quote:${quoteId}`,
    reasons: Array.isArray(input.reasons) && input.reasons.length ? input.reasons : ['accepted quote ready for canonical booking'],
    evidence: Array.isArray(input.evidence) && input.evidence.length ? input.evidence : [{
      kind: 'quote_acceptance',
      summary: 'authoritative accepted quote supplied for booking handoff',
      source_ref: clean(input.quote_acceptance_source_ref) ?? `quote:${quoteId}:accepted`,
    }],
  });

  if (booking.disposition === 'duplicate_suppressed') {
    return Object.freeze({
      schema: QUOTE_BOOKING_FLOW_SCHEMA,
      company_id: companyId,
      state: 'booking_duplicate_suppressed',
      existing_booking_id: clean(input.duplicate_check?.existing_booking_id),
      next: null,
      proposed_booking: booking.proposed_packet,
      continuity,
      restrictions: booking.restrictions,
      authority_neutral: true,
      execution_authority: false,
    });
  }

  const requested = input.booking_context ?? {};
  const handoff = Object.freeze({
    ...booking.handoff,
    payload: Object.freeze({
      company_id: companyId,
      customer_id: customerId,
      quote_ref: quoteId,
      service_id: clean(input.service_context?.service_id),
      location_id: clean(input.service_context?.location_id),
      requested_start: clean(requested.requested_start),
      requested_end: clean(requested.requested_end),
      correlation_id: correlationId,
      journey_id: continuity.journey_id,
    }),
    confirmed_booking_continuation: Object.freeze({
      required_truth: 'authoritative_confirmed_booking_receipt',
      next_target: 'Scheduling Agent',
      adapter: 'titan-workforce/starter-agents/scheduling/scheduling-adapters.mjs',
      proposal_only: true,
      assignment_performed: false,
      grants_authority: false,
      preserve_refs: continuity,
    }),
  });

  return Object.freeze({
    schema: QUOTE_BOOKING_FLOW_SCHEMA,
    company_id: companyId,
    state: 'booking_ready',
    next: handoff,
    continuity,
    restrictions: booking.restrictions,
    authority_neutral: true,
    execution_authority: false,
  });
}

export function planConfirmedBookingToScheduling(input = {}) {
  rejectLegacyBoundary(input, 'booking-scheduling-flow');
  const companyId = clean(input.company_id);
  const bookingId = clean(input.booking_id ?? input.appointment_id);
  const quoteRef = clean(input.quote_ref ?? input.quote_id);
  const correlationId = clean(input.correlation_id);
  if (!companyId) throw new TypeError('company_id is required');
  if (!bookingId) throw new TypeError('booking_id is required');
  if (!quoteRef) throw new TypeError('quote_ref is required');
  if (!correlationId) throw new TypeError('correlation_id is required');
  if (!confirmedBookingStatus(input.booking_status)) throw new TypeError('confirmed booking is required before scheduling handoff');
  assertCompany(companyId, input.scheduling_context, 'scheduling_context');
  assertCompany(companyId, input.booking_receipt, 'booking_receipt');

  return Object.freeze({
    schema: BOOKING_SCHEDULING_FLOW_SCHEMA,
    company_id: companyId,
    state: 'scheduling_proposal_ready',
    next: Object.freeze({
      target: 'Scheduling Agent',
      adapter: 'titan-workforce/starter-agents/scheduling/scheduling-adapters.mjs',
      purpose: 'evaluate_confirmed_booking_for_schedule_proposal',
      booking_ref: Object.freeze({
        booking_id: bookingId,
        appointment_id: clean(input.appointment_id),
        quote_ref: quoteRef,
        customer_id: clean(input.customer_id),
        correlation_id: correlationId,
        journey_id: clean(input.journey_id),
      }),
      context: Object.freeze({ ...(input.scheduling_context ?? {}), company_id: companyId }),
      proposal_only: true,
      assignment_performed: false,
      grants_authority: false,
    }),
    restrictions: Object.freeze({
      booking_mutation_performed: false,
      scheduling_assignment_performed: false,
      workforce_mutation_performed: false,
      downstream_completion_inferred: false,
    }),
    authority_neutral: true,
    execution_authority: false,
  });
}


export const BOOKING_JOB_FLOW_SCHEMA = 'titan.business.booking-job-flow.v1';

export function planConfirmedBookingToJob(input = {}) {
  rejectLegacyBoundary(input, 'booking-job-flow');
  const companyId = clean(input.company_id);
  const bookingId = clean(input.booking_id ?? input.booking_ref?.id);
  const correlationId = clean(input.correlation_id);
  if (!companyId) throw new TypeError('company_id is required');
  if (!bookingId) throw new TypeError('booking_id is required');
  if (!correlationId) throw new TypeError('correlation_id is required');
  if (!confirmedBookingStatus(input.booking_status ?? input.booking_state)) {
    throw new TypeError('confirmed booking is required before job handoff');
  }

  for (const [label, value] of Object.entries({
    booking_context: input.booking_context,
    scheduling_context: input.scheduling_context,
    dispatch_context: input.dispatch_context,
  })) assertCompany(companyId, value, label);

  const bookingContext = Object.freeze({
    ...(input.booking_context ?? {}),
    company_id: companyId,
    booking_id: bookingId,
    customer_id: clean(input.customer_id ?? input.booking_context?.customer_id),
    service_id: clean(input.service_id ?? input.booking_context?.service_id),
    property_id: clean(input.property_id ?? input.booking_context?.property_id),
    address: clean(input.address ?? input.booking_context?.address),
    service_request_id: clean(input.service_request_id ?? input.booking_context?.service_request_id),
    appointment_id: clean(input.appointment_id ?? input.booking_context?.appointment_id),
  });

  const jobsHandoff = buildJobsHandoff({
    company_id: companyId,
    booking_id: bookingId,
    booking_ref: { id: bookingId },
    booking_state: 'confirmed',
    correlation_id: correlationId,
    customer_ref: bookingContext.customer_id ? { id: bookingContext.customer_id } : null,
    site_ref: bookingContext.property_id ? { id: bookingContext.property_id } : null,
    service_ref: bookingContext.service_id ? { id: bookingContext.service_id } : null,
    quote_ref: clean(input.quote_ref ?? input.quote_id) ? { id: clean(input.quote_ref ?? input.quote_id) } : null,
    starts_at: clean(input.scheduling_context?.scheduled_start ?? input.starts_at),
    ends_at: clean(input.scheduling_context?.scheduled_end ?? input.ends_at),
    timezone: clean(input.timezone),
    work_order_ref: input.work_order_ref ?? null,
  });

  const continuity = Object.freeze({
    company_id: companyId,
    booking_id: bookingId,
    appointment_id: clean(input.appointment_id ?? input.scheduling_context?.appointment_id),
    quote_ref: clean(input.quote_ref ?? input.quote_id),
    customer_id: bookingContext.customer_id,
    correlation_id: correlationId,
    journey_id: clean(input.journey_id),
  });

  if (jobsHandoff.ok === false && jobsHandoff.state === 'already_linked') {
    return Object.freeze({
      schema: BOOKING_JOB_FLOW_SCHEMA,
      company_id: companyId,
      state: 'work_order_already_linked',
      work_order_ref: jobsHandoff.work_order_ref,
      next: null,
      continuity,
      restrictions: Object.freeze({
        work_order_creation_performed: false,
        assignment_performed: false,
        crm_mutation_performed: false,
        downstream_completion_inferred: false,
      }),
      authority_neutral: true,
      execution_authority: false,
    });
  }

  const creationContext = compileJobCreationContext({
    company_id: companyId,
    operation_id: clean(input.operation_id) ?? `booking:${bookingId}:job-materialization`,
    booking: bookingContext,
    schedule: Object.freeze({ ...(input.scheduling_context ?? {}), company_id: companyId }),
    dispatch: Object.freeze({ ...(input.dispatch_context ?? {}), company_id: companyId }),
  });
  const dedupe = dedupeJobCreation(input.existing_work_orders ?? [], creationContext);

  if (dedupe.action === 'REUSE_EXISTING') {
    return Object.freeze({
      schema: BOOKING_JOB_FLOW_SCHEMA,
      company_id: companyId,
      state: 'work_order_duplicate_suppressed',
      work_order_ref: dedupe.job_ref,
      next: null,
      continuity,
      idempotency_key: creationContext.idempotency_key,
      restrictions: Object.freeze({
        work_order_creation_performed: false,
        assignment_performed: false,
        crm_mutation_performed: false,
        downstream_completion_inferred: false,
      }),
      authority_neutral: true,
      execution_authority: false,
    });
  }

  return Object.freeze({
    schema: BOOKING_JOB_FLOW_SCHEMA,
    company_id: companyId,
    state: 'work_order_proposal_ready',
    next: Object.freeze({
      target: 'Jobs Agent',
      handoff: jobsHandoff.packet,
      workflow: Object.freeze({
        path: 'titan-business-services/workflows/create_job.json',
        capability: 'crm.work_order.create',
      }),
      creation_context: creationContext,
      assignment: Object.freeze({
        worker_ids: Object.freeze([...(creationContext.assignment?.worker_ids ?? [])]),
        scheduled_start: creationContext.assignment?.scheduled_start ?? null,
        scheduled_end: creationContext.assignment?.scheduled_end ?? null,
        proposal_only: true,
        assignment_performed: false,
        grants_authority: false,
      }),
      proposal_only: true,
      requires_authority_gate: true,
      requires_command_bus: true,
      assignment_performed: false,
      grants_authority: false,
    }),
    continuity,
    idempotency_key: creationContext.idempotency_key,
    restrictions: Object.freeze({
      work_order_creation_performed: false,
      assignment_performed: false,
      crm_mutation_performed: false,
      downstream_completion_inferred: false,
    }),
    authority_neutral: true,
    execution_authority: false,
  });
}


export const CLEANING_JOB_EXECUTION_SCHEMA = 'titan.business.cleaning-job-execution-context.v1';

function list(value) {
  return Array.isArray(value) ? value : [];
}

function verifiedRef(item, label) {
  if (!item || typeof item !== 'object') throw new TypeError(`${label} item must be an object`);
  rejectLegacyBoundary(item, label);
  const sourceRef = clean(item.source_ref);
  if (!sourceRef) throw new TypeError(`${label} item source_ref is required`);
  return sourceRef;
}

export function planCleaningJobExecutionContext(input = {}) {
  rejectLegacyBoundary(input, 'cleaning-job-execution-context');
  const companyId = clean(input.company_id);
  const jobId = clean(input.job_id ?? input.work_order_id);
  const bookingRef = clean(input.booking_ref ?? input.booking_id);
  const correlationId = clean(input.correlation_id);
  if (!companyId) throw new TypeError('company_id is required');
  if (!jobId) throw new TypeError('job_id or work_order_id is required');
  if (!bookingRef) throw new TypeError('booking_ref is required');
  if (!correlationId) throw new TypeError('correlation_id is required');
  if (input.job_receipt?.authoritative !== true || !clean(input.job_receipt?.source_ref)) {
    throw new TypeError('authoritative job receipt with source_ref is required');
  }

  for (const [label, value] of Object.entries({
    job_receipt: input.job_receipt,
    site_context: input.site_context,
    customer_context: input.customer_context,
  })) assertCompany(companyId, value, label);

  const checklist = list(input.checklist).map((item, index) => {
    assertCompany(companyId, item, `checklist[${index}]`);
    verifiedRef(item, 'checklist');
    const taskId = clean(item.task_id ?? item.id);
    if (!taskId) throw new TypeError('checklist task_id is required');
    return Object.freeze({
      task_id: taskId,
      label: clean(item.label),
      area: clean(item.area),
      completion_criteria: clean(item.completion_criteria),
      required: item.required !== false,
      source_ref: clean(item.source_ref),
      state: clean(item.state) ?? 'pending',
    });
  });

  const siteInstructions = list(input.site_instructions).map((item, index) => {
    assertCompany(companyId, item, `site_instructions[${index}]`);
    verifiedRef(item, 'site instruction');
    const instructionId = clean(item.instruction_id ?? item.id);
    if (!instructionId) throw new TypeError('site instruction id is required');
    return Object.freeze({
      instruction_id: instructionId,
      instruction: clean(item.instruction),
      category: clean(item.category),
      source_ref: clean(item.source_ref),
      customer_confirmed: item.customer_confirmed === true,
    });
  });

  const hazards = list(input.hazards).map((item, index) => {
    assertCompany(companyId, item, `hazards[${index}]`);
    verifiedRef(item, 'hazard');
    const hazardId = clean(item.hazard_id ?? item.id);
    if (!hazardId) throw new TypeError('hazard id is required');
    const severity = (clean(item.severity) ?? 'unknown').toLowerCase();
    const observed = item.observed === true;
    return Object.freeze({
      hazard_id: hazardId,
      description: clean(item.description),
      severity,
      observed,
      source_ref: clean(item.source_ref),
      controls: Object.freeze(list(item.controls).map(clean).filter(Boolean)),
      requires_authorised_review: item.requires_authorised_review === true || ['high','critical','unknown'].includes(severity) || !observed,
    });
  });

  const evidenceRequirements = list(input.evidence_requirements).map((item, index) => {
    assertCompany(companyId, item, `evidence_requirements[${index}]`);
    verifiedRef(item, 'evidence requirement');
    const requirementId = clean(item.requirement_id ?? item.id);
    if (!requirementId) throw new TypeError('evidence requirement id is required');
    return Object.freeze({
      requirement_id: requirementId,
      kind: clean(item.kind) ?? 'photo',
      area: clean(item.area),
      stage: clean(item.stage) ?? 'completion',
      source_ref: clean(item.source_ref),
      required: item.required !== false,
      satisfied: item.satisfied === true,
      evidence_refs: Object.freeze(list(item.evidence_refs).map(clean).filter(Boolean)),
    });
  });

  const reviewRequired = hazards.some((hazard) => hazard.requires_authorised_review);
  const requiredEvidenceOutstanding = evidenceRequirements.filter((item) => item.required && !item.satisfied).map((item) => item.requirement_id);
  const requiredChecklistOutstanding = checklist.filter((item) => item.required && item.state !== 'complete').map((item) => item.task_id);

  return Object.freeze({
    schema: CLEANING_JOB_EXECUTION_SCHEMA,
    company_id: companyId,
    state: reviewRequired ? 'execution_context_review_required' : 'execution_context_ready',
    job_ref: Object.freeze({
      job_id: jobId,
      work_order_id: clean(input.work_order_id),
      booking_ref: bookingRef,
      quote_ref: clean(input.quote_ref),
      customer_id: clean(input.customer_id),
      correlation_id: correlationId,
      journey_id: clean(input.journey_id),
    }),
    execution_context: Object.freeze({
      checklist: Object.freeze(checklist),
      site_instructions: Object.freeze(siteInstructions),
      hazards: Object.freeze(hazards),
      evidence_requirements: Object.freeze(evidenceRequirements),
    }),
    gates: Object.freeze({
      authorised_review_required: reviewRequired,
      required_checklist_outstanding: Object.freeze(requiredChecklistOutstanding),
      required_evidence_outstanding: Object.freeze(requiredEvidenceOutstanding),
      completion_may_be_inferred: false,
    }),
    next: Object.freeze({
      target: 'Jobs Agent',
      purpose: 'attach_verified_cleaning_execution_context_to_existing_job',
      proposal_only: true,
      direct_mutation: false,
      completion_performed: false,
      grants_authority: false,
    }),
    restrictions: Object.freeze({
      job_mutation_performed: false,
      checklist_completion_performed: false,
      hazard_clearance_performed: false,
      evidence_acceptance_performed: false,
      job_completion_performed: false,
      downstream_completion_inferred: false,
    }),
    authority_neutral: true,
    execution_authority: false,
  });
}


export const CLEANING_JOB_COMPLETION_SCHEMA = 'titan.business.cleaning-job-completion-plan.v1';

export function planCleaningJobCompletion(input = {}) {
  rejectLegacyBoundary(input, 'cleaning-job-completion');
  const companyId = clean(input.company_id);
  const jobId = clean(input.job_id ?? input.work_order_id);
  const correlationId = clean(input.correlation_id);
  if (!companyId) throw new TypeError('company_id is required');
  if (!jobId) throw new TypeError('job_id or work_order_id is required');
  if (!correlationId) throw new TypeError('correlation_id is required');
  if (input.job_receipt?.authoritative !== true || !clean(input.job_receipt?.source_ref)) {
    throw new TypeError('authoritative job receipt with source_ref is required');
  }
  assertCompany(companyId, input.job_receipt, 'job_receipt');
  assertCompany(companyId, input.execution_context, 'execution_context');

  const requirements = list(input.execution_context?.evidence_requirements ?? input.evidence_requirements).map((item, index) => {
    assertCompany(companyId, item, `evidence_requirements[${index}]`);
    verifiedRef(item, 'evidence requirement');
    const requirementId = clean(item.requirement_id ?? item.id);
    if (!requirementId) throw new TypeError('evidence requirement id is required');
    const stage = (clean(item.stage) ?? 'completion').toLowerCase();
    const refs = Object.freeze(list(item.evidence_refs).map(clean).filter(Boolean));
    return Object.freeze({
      requirement_id: requirementId,
      stage,
      required: item.required !== false,
      satisfied: item.satisfied === true || refs.length > 0,
      evidence_refs: refs,
      source_ref: clean(item.source_ref),
    });
  });

  const checklist = list(input.execution_context?.checklist ?? input.checklist).map((item, index) => {
    assertCompany(companyId, item, `checklist[${index}]`);
    verifiedRef(item, 'checklist');
    const taskId = clean(item.task_id ?? item.id);
    if (!taskId) throw new TypeError('checklist task_id is required');
    const complete = item.completed === true || ['complete','completed','done'].includes((clean(item.state) ?? '').toLowerCase());
    return Object.freeze({ task_id: taskId, required: item.required !== false, completed: complete, source_ref: clean(item.source_ref) });
  });

  const beforeOutstanding = requirements.filter((x) => x.required && x.stage === 'before' && !x.satisfied).map((x) => x.requirement_id);
  const afterOutstanding = requirements.filter((x) => x.required && x.stage === 'after' && !x.satisfied).map((x) => x.requirement_id);
  const completionOutstanding = requirements.filter((x) => x.required && !['before','after'].includes(x.stage) && !x.satisfied).map((x) => x.requirement_id);
  const allEvidenceRefs = [...new Set(requirements.flatMap((x) => x.evidence_refs))];

  const exceptions = list(input.exceptions).map((item, index) => {
    assertCompany(companyId, item, `exceptions[${index}]`);
    const exceptionId = clean(item.exception_id ?? item.id);
    if (!exceptionId) throw new TypeError('exception id is required');
    return Object.freeze({
      exception_id: exceptionId,
      type: clean(item.type) ?? 'blocked',
      status: clean(item.status) ?? 'OPEN',
      blocks_completion: item.blocks_completion !== false,
      source_ref: clean(item.source_ref),
    });
  });

  const evidence = {
    company_id: companyId,
    job_id: jobId,
    checklist: checklist.map((x) => ({ required: x.required, completed: x.completed })),
    evidence_attachment_ids: allEvidenceRefs,
    evidence_refs: allEvidenceRefs,
    damage_reported: input.damage_reported === true,
    exception_notes: clean(input.exception_notes),
    customer_signature: clean(input.customer_signature),
    from_state: clean(input.from_state),
  };

  const readiness = evaluateJobCompletionReadiness({
    company_id: companyId,
    job_id: jobId,
    current_state: clean(input.current_state) ?? 'qa_ready',
    field_context: input.field_context ?? { context: { tasks: [], checklist: [], equipment: [] } },
    evidence,
    exceptions,
    request_invoice: input.request_invoice !== false,
    supervisor_review_passed: input.supervisor_review_passed === true,
  }, input.jobs_settings ?? {});

  const stageBlockers = [
    ...beforeOutstanding.map((id) => `BEFORE_EVIDENCE:${id}`),
    ...afterOutstanding.map((id) => `AFTER_EVIDENCE:${id}`),
    ...completionOutstanding.map((id) => `COMPLETION_EVIDENCE:${id}`),
  ];
  const blockers = Object.freeze([...stageBlockers, ...readiness.blockers]);
  const readyForCompletionProposal = blockers.length === 0;

  return Object.freeze({
    schema: CLEANING_JOB_COMPLETION_SCHEMA,
    company_id: companyId,
    state: readyForCompletionProposal ? 'completion_proposal_ready' : 'completion_qa_blocked',
    job_ref: Object.freeze({
      job_id: jobId,
      work_order_id: clean(input.work_order_id),
      booking_ref: clean(input.booking_ref),
      quote_ref: clean(input.quote_ref),
      correlation_id: correlationId,
      journey_id: clean(input.journey_id),
    }),
    qa: Object.freeze({
      checklist: Object.freeze(checklist),
      evidence_requirements: Object.freeze(requirements),
      before_evidence_outstanding: Object.freeze(beforeOutstanding),
      after_evidence_outstanding: Object.freeze(afterOutstanding),
      completion_evidence_outstanding: Object.freeze(completionOutstanding),
      evidence_refs: Object.freeze(allEvidenceRefs),
      exceptions: Object.freeze(exceptions),
      jobs_readiness: readiness,
      blockers,
    }),
    next: Object.freeze({
      target: 'Titan CRM / Jobs authority',
      capability: 'crm.work_order.complete',
      purpose: 'submit_verified_cleaning_completion_proposal',
      proposal_only: true,
      direct_mutation: false,
      permitted: readyForCompletionProposal,
      grants_authority: false,
    }),
    restrictions: Object.freeze({
      evidence_acceptance_performed: false,
      exception_resolution_performed: false,
      supervisor_approval_performed: false,
      work_order_completion_performed: false,
      invoice_creation_performed: false,
      downstream_completion_inferred: false,
    }),
    authority_neutral: true,
    execution_authority: false,
  });
}

export const CLEANING_INVOICE_READINESS_SCHEMA = 'titan.business.cleaning-invoice-readiness-plan.v1';

export function planCleaningInvoiceReadiness(input = {}) {
  rejectLegacyBoundary(input, 'cleaning-invoice-readiness');
  const companyId = clean(input.company_id);
  const jobId = clean(input.job_id ?? input.work_order_id);
  const customerId = clean(input.customer_id);
  const correlationId = clean(input.correlation_id);
  if (!companyId) throw new TypeError('company_id is required');
  if (!jobId) throw new TypeError('job_id or work_order_id is required');
  if (!customerId) throw new TypeError('customer_id is required');
  if (!correlationId) throw new TypeError('correlation_id is required');

  assertCompany(companyId, input.completion_plan, 'completion_plan');
  assertCompany(companyId, input.invoice_context, 'invoice_context');
  assertCompany(companyId, input.duplicate_check, 'duplicate_check');
  assertCompany(companyId, input.invoice_receipt, 'invoice_receipt');

  const completionPlan = input.completion_plan;
  if (!completionPlan || completionPlan.schema !== CLEANING_JOB_COMPLETION_SCHEMA) {
    throw new TypeError('cleaning completion plan is required');
  }
  if (completionPlan.state !== 'completion_proposal_ready' || completionPlan.next?.permitted !== true) {
    throw new TypeError('completion QA is not ready for downstream invoicing');
  }
  if (clean(completionPlan.job_ref?.job_id) !== jobId) throw new TypeError('completion plan job mismatch');

  const duplicateInvoiceId = clean(input.duplicate_check?.existing_invoice_id ?? input.existing_invoice_id);
  const duplicateConfirmed = input.duplicate_check?.authoritative === true && !!duplicateInvoiceId;

  const invoiceContext = input.invoice_context ?? {};
  const lineItems = list(invoiceContext.line_items ?? input.line_items);
  const subtotal = Number(invoiceContext.subtotal ?? input.subtotal);
  const tax = Number(invoiceContext.tax ?? input.tax);
  const total = Number(invoiceContext.total ?? input.total);
  const dueDate = clean(invoiceContext.due_date ?? input.due_date);
  const paymentMethod = clean(invoiceContext.payment_method ?? input.payment_method);
  const sendToCustomer = invoiceContext.send_to_customer ?? input.send_to_customer;
  const invoiceInputsReady = lineItems.length > 0 && Number.isFinite(subtotal) && subtotal >= 0 && Number.isFinite(tax) && tax >= 0 && Number.isFinite(total) && total >= 0 && !!dueDate && !!paymentMethod && typeof sendToCustomer === 'boolean';

  const blockers = [];
  if (duplicateConfirmed) blockers.push('AUTHORITATIVE_INVOICE_ALREADY_EXISTS');
  if (!invoiceInputsReady) blockers.push('INVOICE_INPUTS_INCOMPLETE');

  const invoiceReceipt = input.invoice_receipt ?? null;
  const invoiceAuthoritative = invoiceReceipt?.authoritative === true && !!clean(invoiceReceipt?.invoice_id) && !!clean(invoiceReceipt?.source_ref);
  if (invoiceReceipt) {
    if (!invoiceAuthoritative) throw new TypeError('invoice receipt must be authoritative with invoice_id and source_ref');
    assertCompany(companyId, invoiceReceipt, 'invoice_receipt');
    const receiptJobId = clean(invoiceReceipt.job_id ?? invoiceReceipt.work_order_id);
    if (receiptJobId && receiptJobId !== jobId) throw new TypeError('invoice receipt job mismatch');
  }

  const invoiceProposalPermitted = blockers.length === 0 && !invoiceAuthoritative;
  const paymentReconciliationReady = invoiceAuthoritative;

  return Object.freeze({
    schema: CLEANING_INVOICE_READINESS_SCHEMA,
    company_id: companyId,
    state: invoiceAuthoritative ? 'invoice_created_payment_reconciliation_ready' : invoiceProposalPermitted ? 'invoice_proposal_ready' : 'invoice_readiness_blocked',
    job_ref: Object.freeze({
      job_id: jobId,
      work_order_id: clean(input.work_order_id),
      customer_id: customerId,
      booking_ref: clean(input.booking_ref),
      quote_ref: clean(input.quote_ref),
      completion_ref: clean(input.completion_ref),
      correlation_id: correlationId,
      journey_id: clean(input.journey_id),
    }),
    invoice: Object.freeze({
      capability: 'crm.invoice.create',
      workflow: 'titan-business-services/workflows/create_invoice.json',
      owner: 'Titan CRM revenue document authority',
      proposal_permitted: invoiceProposalPermitted,
      duplicate_invoice_id: duplicateInvoiceId,
      inputs_ready: invoiceInputsReady,
      blockers: Object.freeze(blockers),
      proposed_fields: Object.freeze({
        customer_id: customerId,
        job_id: jobId,
        line_items: Object.freeze([...lineItems]),
        subtotal: Number.isFinite(subtotal) ? subtotal : null,
        tax: Number.isFinite(tax) ? tax : null,
        total: Number.isFinite(total) ? total : null,
        due_date: dueDate,
        payment_method: paymentMethod,
        send_to_customer: typeof sendToCustomer === 'boolean' ? sendToCustomer : null,
        notes: clean(invoiceContext.notes ?? input.notes),
      }),
      proposal_only: true,
      direct_mutation: false,
      grants_authority: false,
    }),
    payment: Object.freeze({
      capability: 'finance.payment.reconcile',
      workflow: 'titan-business-services/workflows/payment_reconciliation.json',
      authority: 'user_only',
      invoice_id: invoiceAuthoritative ? clean(invoiceReceipt.invoice_id) : null,
      ready: paymentReconciliationReady,
      reason: paymentReconciliationReady ? 'authoritative_invoice_receipt_present' : 'await_authoritative_invoice_receipt',
      proposal_only: true,
      direct_mutation: false,
      grants_authority: false,
    }),
    restrictions: Object.freeze({
      invoice_creation_performed: false,
      invoice_delivery_performed: false,
      payment_reconciliation_performed: false,
      payment_state_mutated: false,
      receivable_state_mutated: false,
      duplicate_financial_authority_created: false,
    }),
    authority_neutral: true,
    execution_authority: false,
  });
}


export const CLEANING_SERVICE_CONTINUITY_SCHEMA = 'titan.business.cleaning-service-continuity-plan.v1';

function requireAuthoritativeReceipt(companyId, receipt, label, idFields = []) {
  assertCompany(companyId, receipt, label);
  if (!receipt || receipt.authoritative !== true || !clean(receipt.source_ref)) {
    throw new TypeError(`${label} must be authoritative with source_ref`);
  }
  if (idFields.length && !idFields.some((field) => clean(receipt[field]))) {
    throw new TypeError(`${label} requires authoritative identifier`);
  }
  return receipt;
}

export function planCleaningServiceContinuity(input = {}) {
  rejectLegacyBoundary(input, 'cleaning-service-continuity');
  const companyId = clean(input.company_id);
  const action = clean(input.action)?.toLowerCase();
  const correlationId = clean(input.correlation_id);
  if (!companyId) throw new TypeError('company_id is required');
  if (!correlationId) throw new TypeError('correlation_id is required');
  if (!['recurring','reschedule','cancel','rework'].includes(action)) throw new TypeError('supported continuity action is required');

  for (const [label, value] of Object.entries({
    booking_receipt: input.booking_receipt,
    job_receipt: input.job_receipt,
    recurrence_context: input.recurrence_context,
    scheduling_context: input.scheduling_context,
    rework_context: input.rework_context,
  })) assertCompany(companyId, value, label);

  const base = {
    schema: CLEANING_SERVICE_CONTINUITY_SCHEMA,
    company_id: companyId,
    action,
    correlation_id: correlationId,
    authority_neutral: true,
    execution_authority: false,
  };

  if (action === 'recurring') {
    const recurrence = input.recurrence_context ?? {};
    const scheduleId = clean(recurrence.schedule_id);
    const workRef = clean(recurrence.work_ref ?? input.job_id ?? input.booking_id);
    if (!scheduleId) throw new TypeError('recurrence schedule_id is required');
    if (!workRef) throw new TypeError('recurrence work_ref is required');
    const now = Number(recurrence.now ?? input.now ?? Date.now());
    const runtime = buildWorkforceScheduleRecurrence({
      company_id: companyId,
      now,
      schedules: [{
        schedule_id: scheduleId,
        frequency: recurrence.frequency ?? 'WEEKLY',
        interval: recurrence.interval,
        start_at: recurrence.start_at,
        end_at: recurrence.end_at,
        timezone: recurrence.timezone,
        work_ref: workRef,
        enabled: recurrence.enabled !== false,
        catch_up_limit: recurrence.catch_up_limit,
        max_instances: recurrence.max_instances,
      }],
    });
    const due = evaluateWorkforceScheduleDue(runtime, { company_id: companyId, now });
    return Object.freeze({
      ...base,
      state: due.due_count > 0 ? 'recurring_instances_proposal_ready' : 'recurring_schedule_registered_no_due_instance',
      recurrence: Object.freeze({ runtime, due }),
      next: Object.freeze({
        target: 'Recurring Services Coordinator / Booking authority',
        capability: 'crm.appointment.create',
        workflow: 'titan-business-services/workflows/service_booking.json',
        due_instances: Object.freeze(due.instances.map((instance) => Object.freeze({ ...instance, proposal_only: true, requires_fresh_authority_evaluation: true }))),
        proposal_only: true,
        automatic_booking_creation: false,
        grants_authority: false,
      }),
      restrictions: Object.freeze({ schedule_execution_performed:false, booking_creation_performed:false, assignment_performed:false, crm_mutation_performed:false }),
    });
  }

  if (action === 'reschedule' || action === 'cancel') {
    const receipt = requireAuthoritativeReceipt(companyId, input.booking_receipt, 'booking_receipt', ['booking_id','appointment_id','provider_booking_id']);
    const provider = clean(receipt.provider ?? input.provider);
    const providerBookingId = clean(receipt.provider_booking_id ?? receipt.booking_id ?? receipt.appointment_id);
    const providerRevision = clean(input.provider_revision ?? receipt.provider_revision ?? receipt.revision);
    if (!provider) throw new TypeError('booking provider is required for reconciliation');
    if (!providerRevision) throw new TypeError('provider revision is required for reconciliation');
    if (action === 'reschedule' && (!clean(input.requested_start ?? input.starts_at) || !clean(input.requested_end ?? input.ends_at))) {
      throw new TypeError('reschedule requires requested start and end');
    }
    const event = normalizeCalendarEvent({
      company_id: companyId,
      kind: action === 'cancel' ? 'cancelled' : 'rescheduled',
      event_id: clean(input.event_id) ?? `${providerBookingId}:${action}:${providerRevision}`,
      provider,
      provider_booking_id: providerBookingId,
      provider_revision: providerRevision,
      starts_at: action === 'reschedule' ? clean(input.requested_start ?? input.starts_at) : null,
      ends_at: action === 'reschedule' ? clean(input.requested_end ?? input.ends_at) : null,
      correlation_id: correlationId,
    });
    return Object.freeze({
      ...base,
      state: action === 'cancel' ? 'cancellation_reconciliation_required' : 'reschedule_reconciliation_required',
      booking_ref: Object.freeze({ booking_id: clean(receipt.booking_id), appointment_id: clean(receipt.appointment_id), source_ref: clean(receipt.source_ref) }),
      reconciliation_event: event,
      next: Object.freeze({
        target: 'Booking / Scheduling reconciliation',
        adapter: 'titan-workforce/starter-agents/booking/calendar-reconciliation.mjs',
        purpose: action === 'cancel' ? 'reconcile_authoritative_cancellation_request' : 'reconcile_authoritative_reschedule_request',
        human_review_required: action === 'cancel' || input.human_review_required === true,
        proposal_only: true,
        direct_mutation: false,
        grants_authority: false,
      }),
      restrictions: Object.freeze({ booking_mutation_performed:false, cancellation_performed:false, reschedule_performed:false, schedule_assignment_performed:false, crm_mutation_performed:false }),
    });
  }

  const receipt = requireAuthoritativeReceipt(companyId, input.job_receipt, 'job_receipt', ['job_id','work_order_id']);
  const jobId = clean(receipt.job_id ?? receipt.work_order_id ?? input.job_id ?? input.work_order_id);
  const rework = input.rework_context ?? {};
  const exception = classifyJobException({
    company_id: companyId,
    job_id: jobId,
    type: 'rework',
    exception_id: clean(rework.exception_id),
    operation_id: clean(input.operation_id),
    summary: clean(rework.summary) ?? 'Cleaning quality rework required',
    evidence_refs: list(rework.evidence_refs),
    severity: clean(rework.severity) ?? 'medium',
    rework_resolved: false,
  });
  const resolution = planExceptionResolution(exception, {
    company_id: companyId,
    action: 'start_rework',
    authority_verified: input.authority_verified === true,
  });
  return Object.freeze({
    ...base,
    state: resolution.status === 'READY' ? 'rework_proposal_ready' : 'rework_authority_review_required',
    job_ref: Object.freeze({ job_id: jobId, work_order_id: clean(receipt.work_order_id), source_ref: clean(receipt.source_ref) }),
    exception: Object.freeze(exception),
    resolution: Object.freeze(resolution),
    next: Object.freeze({
      target: 'Jobs / Quality authority',
      capability: 'crm.work_order.update',
      workflow: 'titan-business-services/workflows/job_variation_approval.json',
      purpose: 'governed_cleaning_rework_transition',
      proposal_only: true,
      requires_command_bus: true,
      grants_authority: false,
    }),
    restrictions: Object.freeze({ exception_resolution_performed:false, rework_started:false, work_order_mutation_performed:false, completion_inferred:false, invoice_mutation_performed:false }),
  });
}
