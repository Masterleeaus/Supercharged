# Capability Registry

Generated 2026-11-03 from the role files in `server/workforce/catalogue/roles/` (`_example.ts` skipped).

## Method

- Each of the 125 role files was parsed for `id`, `autonomy`, `channels`, `tools` and `toolRisk`. Every role declares at least one tool, and every declared tool has a matching `toolRisk` entry.
- The tool table is built only from those declarations. Each tool lists the roles that declare it and the risk each role assigns.
- Read/write is a name-only guess. A tool is marked `read` when its final name segment is `list`, `get`, `read`, `search`, `view`, `check` or a summary, and `write` otherwise. Neither label was checked against code.
- Handler check: each tool ID was searched as a literal string across `server/`, excluding `server/workforce/catalogue/roles/` and any `vendor/` folder. Hits were examined for whether they are handlers or only documentation.
- This registry is generated from role files and name heuristics. It is not generated from handlers, so it describes declared capabilities, not implemented ones.

## Summary

- Role files: 125
- Distinct tool IDs declared: 101
- Tools with a handler outside roles: 0. Three IDs (`booking_requests.create`, `booking_requests.list`, `clients.list`) appear only in `server/workforce/catalogue/SCHEMA.md` and `role.schema.ts` (`booking_requests.create` only in a validation error message), so they are documentation, not handlers. The remaining 98 have no reference at all in `server/`.
- Tools declared at `critical` risk by at least one role: 14

## Roles

| Role | Autonomy | Channels | Tools (risk) |
|---|---|---|---|
| `appointment-reminder` | auto | sms, email | `booking_requests.list` (low), `project_visits.list` (low), `clients.get` (low), `customer_messages.draft` (low), `customer_messages.send` (critical), `staff_tasks.create` (low) |
| `carpet-upholstery-aftercare-follow-up` | auto | sms, email | `service_visits.list` (low), `clients.list` (low), `messages.send` (critical), `complaints.create` (medium), `escalations.create` (low) |
| `carpet-upholstery-job-scheduler` | auto | sms, voice, email | `sites.list` (low), `availability.read` (low), `service_visits.schedule` (medium), `service_visits.reschedule` (high) |
| `carpet-upholstery-quote-intake` | auto | voice, web, sms | `clients.list` (low), `sites.list` (low), `quote_requests.create` (medium) |
| `cleaning-booking-coordinator` | auto | voice, sms, web, email | `clients.list` (low), `availability.read` (low), `booking_requests.list` (low), `booking_requests.create` (medium), `booking_requests.update` (high) |
| `cleaning-crew-roster-coordinator` | auto | chat, email | `crew_rosters.list` (low), `crew_rosters.update` (high), `service_visits.list` (low), `availability.read` (low) |
| `cleaning-customer-care` | auto | voice, sms, email, chat | `clients.list` (low), `booking_requests.list` (low), `service_visits.list` (low), `complaints.create` (medium), `messages.send` (critical), `escalations.create` (low) |
| `cleaning-enquiry-reception` | auto | voice, sms, web | `clients.list` (low), `sites.list` (low), `booking_requests.create` (medium) |
| `cleaning-feedback-survey` | auto | sms, email, voice | `clients.list` (low), `service_visits.list` (low), `feedback_surveys.send` (critical), `escalations.create` (low) |
| `cleaning-invoice-query-desk` | auto | email, sms, voice | `invoices.list` (low), `clients.list` (low), `invoice_disputes.create` (medium), `refund_requests.create` (critical) |
| `cleaning-post-visit-quality-check` | suggest | chat, email | `job_checklists.list` (low), `job_photos.list` (low), `service_visits.list` (low) |
| `cleaning-quote-intake` | auto | voice, web, email | `clients.list` (low), `sites.list` (low), `quote_requests.create` (medium) |
| `collections-follow-up` | auto | email, voice | `invoices.list` (low), `invoices.get` (low), `payments.list` (low), `clients.get` (low), `payment_plans.propose` (critical), `customer_messages.draft` (low), `customer_messages.send` (critical), `collection_notes.create` (low), `staff_tasks.create` (low) |
| `commercial-cleaning-outbound-prospecting` | auto | email, voice | `clients.list` (low), `opportunities.create` (medium), `messages.send` (critical) |
| `commercial-cleaning-site-visit-scheduler` | auto | email, voice, sms | `clients.list` (low), `sites.list` (low), `property_contacts.list` (low), `availability.read` (low), `site_visits.schedule` (medium) |
| `complaint-triage` | auto | email, chat, web | `clients.get` (low), `projects.get` (low), `property_issues.list` (low), `property_issues.create` (medium), `customer_messages.draft` (low), `staff_tasks.create` (low) |
| `compliance-expiry-tracker` | suggest | email | `compliance_documents.list` (low), `users.list` (low), `staff_tasks.create` (low) |
| `customer-data-hygiene` | suggest | email | `clients.list` (low), `client_duplicates.list` (low), `client_merge_suggestions.create` (critical), `staff_tasks.create` (low) |
| `dispute-intake` | auto | email, web | `invoices.get` (low), `payments.list` (low), `clients.get` (low), `disputes.create` (medium), `customer_messages.draft` (low), `customer_messages.send` (critical), `staff_tasks.create` (low) |
| `end-of-lease-clean-coordinator` | auto | email, web, voice, sms | `clients.list` (low), `sites.list` (low), `property_contacts.list` (low), `availability.read` (low), `booking_requests.create` (medium), `end_of_lease_checklists.create` (medium) |
| `field-customer-care-recovery` | auto | sms, email, chat | `clients.get` (low), `property_issues.list` (low), `property_issues.create` (medium), `messages.draft_customer` (low), `messages.send_customer` (critical) |
| `field-customer-status-update` | auto | sms, email, whatsapp | `projects.get` (low), `visits.get` (low), `messages.draft_customer` (low), `messages.send_customer` (critical) |
| `field-daily-schedule-brief` | suggest | chat, email | `project_visits.list` (low), `work_orders.list` (low), `users.list` (low) |
| `field-eta-delay-notice` | auto | sms, whatsapp, chat | `visits.get` (low), `project_visits.list` (low), `messages.draft_customer` (low), `messages.send_customer` (critical) |
| `field-job-intake` | auto | voice, sms, web, chat | `clients.list` (low), `booking_requests.list` (low), `booking_requests.create` (medium) |
| `field-job-photo-request` | auto | sms, chat | `job_photos.list` (low), `technician_tasks.create` (medium) |
| `field-materials-parts-reminder` | auto | sms, chat | `projects.get` (low), `work_orders.list` (low), `materials.check` (low), `technician_tasks.create` (medium) |
| `field-no-show-follow-up` | auto | sms, email | `project_visits.list` (low), `visits.get` (low), `messages.draft_customer` (low), `messages.send_customer` (critical), `booking_requests.update` (medium) |
| `field-quote-follow-up` | auto | sms, email, whatsapp | `estimates.list` (low), `clients.get` (low), `messages.draft_customer` (low), `messages.send_customer` (critical) |
| `field-rebooking-reminder` | auto | sms, email | `clients.list` (low), `projects.list` (low), `booking_requests.create` (medium), `messages.send_customer` (critical) |
| `field-review-request` | auto | sms, email, whatsapp | `clients.get` (low), `projects.get` (low), `reviews.request` (critical) |
| `field-schedule-change` | auto | sms, email, whatsapp, chat | `project_visits.list` (low), `visits.update` (high), `messages.draft_customer` (low), `messages.send_customer` (critical) |
| `field-signoff-request` | auto | sms, email, whatsapp | `projects.get` (low), `job_signoff.request` (critical), `job_signoff.record` (high) |
| `field-technician-checkin` | auto | sms, chat | `visits.get` (low), `work_orders.start_visit` (medium) |
| `field-technician-checkout` | auto | sms, chat | `visits.get` (low), `visits.transition` (medium), `job_notes.create` (low) |
| `field-visit-confirmation` | auto | sms, email, whatsapp | `project_visits.list` (low), `visits.get` (low), `messages.draft_customer` (low), `messages.send_customer` (critical) |
| `garden-after-hours-emergency-triage` | auto | voice, sms | `clients.list` (low), `property_issues.create` (medium), `booking_requests.create` (medium) |
| `garden-booking-change-handler` | auto | voice, sms, web | `clients.get` (low), `booking_requests.list` (low), `booking_requests.get` (low), `booking_requests.update` (medium), `project_visits.list` (low) |
| `garden-crew-route-planner` | suggest | chat, web | `project_visits.list` (low), `visits.get` (low), `properties.list` (low), `users.list` (low) |
| `garden-customer-feedback-survey` | auto | voice, sms | `visits.get` (low), `clients.get` (low), `feedback_responses.create` (medium) |
| `garden-irrigation-fault-triage` | auto | voice, chat, sms, web | `clients.get` (low), `property_issues.list` (low), `property_issues.create` (medium), `booking_requests.create` (medium) |
| `garden-irrigation-repair-scheduler` | auto | voice, sms, web | `clients.get` (low), `booking_requests.list` (low), `booking_requests.create` (medium), `project_visits.list` (low) |
| `garden-job-completion-follow-up` | auto | chat, sms, email, web | `visits.get` (low), `work_orders.list` (low), `property_issues.create` (medium), `booking_requests.create` (medium) |
| `garden-job-dispatch-coordinator` | auto | chat, web | `projects.list` (low), `projects.get` (low), `project_visits.list` (low), `visits.get` (low), `visits.update` (high), `users.list` (low), `work_orders.list` (low) |
| `garden-landscape-design-quote-intake` | auto | voice, chat, email, web | `clients.list` (low), `clients.create` (high), `booking_requests.create` (medium), `estimates.create` (high) |
| `garden-lawn-mowing-scheduler` | auto | voice, sms, web | `clients.list` (low), `clients.get` (low), `booking_requests.list` (low), `booking_requests.create` (medium), `project_visits.list` (low) |
| `garden-maintenance-plan-enrolment` | auto | voice, chat, sms, web | `clients.list` (low), `clients.get` (low), `booking_requests.create` (medium), `maintenance_plans.create` (high) |
| `garden-mulch-seasonal-campaign` | auto | sms, email | `clients.list` (low), `clients.get` (low), `campaign_messages.create` (critical) |
| `garden-quote-chaser` | auto | sms, email, voice | `estimates.list` (low), `clients.get` (low), `booking_requests.update` (medium), `messages.send` (critical) |
| `garden-seasonal-reminder` | auto | sms, email | `clients.list` (low), `project_visits.list` (low), `campaign_messages.create` (critical) |
| `garden-service-history-reviewer` | suggest | chat, web | `work_orders.list` (low), `projects.list` (low), `property_issues.list` (low), `visits.get` (low) |
| `garden-tree-lopping-quote-intake` | auto | voice, sms, email, web | `clients.list` (low), `clients.create` (high), `property_issues.create` (medium), `estimates.create` (high) |
| `garden-weed-control-seasonal-campaign` | auto | sms, email | `clients.list` (low), `clients.get` (low), `campaign_messages.create` (critical) |
| `handyman-job-scoping` | auto | chat, sms, web | `booking_requests.get` (low), `booking_requests.update` (medium), `job_photos.request_from_customer` (critical) |
| `handyman-warranty-callback` | auto | sms, email, chat | `clients.get` (low), `projects.get` (low), `property_issues.create` (medium), `messages.draft_customer` (low) |
| `home-cleaning-recurring-scheduler` | auto | sms, email, voice | `clients.list` (low), `service_visits.list` (low), `availability.read` (low), `service_visits.schedule` (medium), `service_visits.reschedule` (high) |
| `invoice-reminder` | auto | email, sms | `invoices.list` (low), `invoices.get` (low), `clients.get` (low), `customer_messages.draft` (low), `customer_messages.send` (critical), `staff_tasks.create` (low) |
| `lapsed-customer-reactivation` | auto | email, sms | `clients.list` (low), `projects.list` (low), `clients.get` (low), `customer_messages.draft` (low), `customer_messages.send` (critical), `staff_tasks.create` (low) |
| `locksmith-arrival-check` | auto | chat, sms | `visits.get` (low), `ownership.verify` (high), `human_escalation.create` (low) |
| `locksmith-escalation-brief` | suggest | chat, web | `clients.get` (low), `booking_requests.get` (low), `human_escalation.create` (low) |
| `locksmith-identity-verification` | auto | voice, sms, email | `clients.get` (low), `identity.verify_request` (critical), `ownership.verify` (high), `human_escalation.create` (low) |
| `locksmith-lockout-intake` | auto | voice, sms, web | `clients.list` (low), `booking_requests.create` (medium), `human_escalation.create` (low) |
| `locksmith-rekey-quote` | auto | email, sms, web | `clients.get` (low), `estimates.list` (low), `estimates.create` (medium) |
| `membership-renewal` | auto | email, sms | `agreements.list` (low), `agreements.renewal_draft` (low), `clients.get` (low), `customer_messages.draft` (low), `customer_messages.send` (critical), `staff_tasks.create` (low) |
| `new-customer-onboarding` | auto | email, sms, web | `clients.list` (low), `clients.get` (low), `clients.create` (medium), `properties.list` (low), `booking_requests.get` (low), `customer_messages.draft` (low), `customer_messages.send` (critical), `staff_tasks.create` (low) |
| `no-show-follow-up` | auto | sms, email | `project_visits.list` (low), `visits.get` (low), `clients.get` (low), `booking_requests.update` (medium), `customer_messages.draft` (low), `customer_messages.send` (critical), `staff_tasks.create` (low) |
| `painting-quote-follow-up` | auto | email, sms | `estimates.list` (low), `clients.get` (low), `messages.draft_customer` (low), `messages.send_customer` (critical) |
| `painting-site-prep-checklist` | suggest | chat, web | `projects.get` (low), `project_visits.list` (low), `materials.check` (low) |
| `payment-reconciliation-check` | suggest | email | `invoices.list` (low), `payments.list` (low), `clients.get` (low), `staff_tasks.create` (low) |
| `payment-reminder` | auto | email, sms | `invoices.list` (low), `invoices.get` (low), `payments.list` (low), `clients.get` (low), `customer_messages.draft` (low), `customer_messages.send` (critical), `collection_notes.create` (low) |
| `pest-inspection-booking` | auto | voice, sms, web | `clients.get` (low), `booking_requests.list` (low), `booking_requests.create` (medium), `project_visits.list` (low) |
| `pest-post-treatment-feedback` | auto | voice, sms | `visits.get` (low), `clients.get` (low), `feedback_responses.create` (medium) |
| `pest-quote-follow-up` | auto | sms, email, voice | `estimates.list` (low), `clients.get` (low), `booking_requests.update` (medium), `messages.send` (critical) |
| `pest-reinspection-scheduler` | auto | voice, sms, web | `project_visits.list` (low), `visits.get` (low), `booking_requests.create` (medium), `booking_requests.update` (medium) |
| `pest-seasonal-reminder` | auto | sms, email | `clients.list` (low), `work_orders.list` (low), `campaign_messages.create` (critical) |
| `pest-service-record-checker` | suggest | chat, web | `work_orders.list` (low), `visits.get` (low), `project_visits.list` (low), `clients.get` (low) |
| `pest-treatment-follow-up` | auto | sms, voice, email | `clients.get` (low), `visits.get` (low), `work_orders.list` (low), `property_issues.create` (medium), `booking_requests.create` (medium) |
| `pest-wildlife-callout-intake` | auto | voice, sms, web | `clients.list` (low), `property_issues.create` (medium), `booking_requests.create` (medium) |
| `pool-booking-coordinator` | auto | voice, sms, web, email | `clients.list` (low), `pool_profiles.list` (low), `availability.read` (low), `booking_requests.list` (low), `booking_requests.create` (medium), `booking_requests.update` (high) |
| `pool-customer-care` | auto | sms, email, voice, chat | `clients.list` (low), `service_visits.list` (low), `complaints.create` (medium), `messages.send` (critical), `escalations.create` (low) |
| `pool-enquiry-reception` | auto | voice, sms, web | `clients.list` (low), `sites.list` (low), `booking_requests.create` (medium) |
| `pool-equipment-fault-intake` | auto | sms, voice, email, web | `pool_equipment.list` (low), `pool_profiles.list` (low), `pool_equipment_faults.create` (medium), `service_visits.schedule` (medium) |
| `pool-equipment-parts-quote-prep` | auto | email, web | `pool_equipment.list` (low), `quote_requests.create` (medium) |
| `pool-service-scheduler` | auto | sms, email, voice | `pool_profiles.list` (low), `service_visits.list` (low), `availability.read` (low), `service_visits.schedule` (medium), `service_visits.reschedule` (high) |
| `pool-water-quality-escalation` | auto | sms, voice, email, chat | `escalations.create` (low), `complaints.create` (medium), `clients.list` (low), `pool_profiles.list` (low) |
| `pool-water-testing-scheduler` | auto | sms, email, voice | `water_test_results.list` (low), `pool_profiles.list` (low), `availability.read` (low), `water_tests.schedule` (medium) |
| `post-job-check-in` | auto | email, sms | `projects.get` (low), `work_orders.list` (low), `clients.get` (low), `customer_messages.draft` (low), `customer_messages.send` (critical), `staff_tasks.create` (low) |
| `quote-follow-up` | auto | email, sms | `estimates.list` (low), `clients.get` (low), `customer_messages.draft` (low), `customer_messages.send` (critical), `staff_tasks.create` (low) |
| `referral-request` | auto | email, sms | `clients.get` (low), `projects.get` (low), `reviews.list` (low), `customer_messages.draft` (low), `customer_messages.send` (critical), `referral_requests.create` (low), `staff_tasks.create` (low) |
| `refund-triage` | suggest | email, web | `invoices.get` (low), `payments.list` (low), `clients.get` (low), `refund_requests.list` (low), `refund_requests.prepare` (critical), `staff_tasks.create` (low) |
| `review-monitor` | suggest | email | `reviews.list` (low), `review_alerts.create` (low), `clients.get` (low), `staff_tasks.create` (low) |
| `service-due-reminder` | auto | email, sms | `service_schedules.list` (low), `properties.list` (low), `clients.get` (low), `booking_requests.create` (medium), `customer_messages.draft` (low), `customer_messages.send` (critical), `staff_tasks.create` (low) |
| `staff-roster-suggestions` | suggest | web, email | `users.list` (low), `project_visits.list` (low), `projects.list` (low), `work_orders.list` (low), `booking_requests.list` (low), `staff_tasks.create` (low) |
| `stock-reorder-suggestions` | suggest | email | `inventory.list` (low), `staff_tasks.create` (low) |
| `supplier-bill-check` | suggest | email | `supplier_bills.list` (low), `purchase_orders.list` (low), `staff_tasks.create` (low) |
| `timesheet-check` | suggest | web, email | `timesheets.list` (low), `users.list` (low), `project_visits.list` (low), `timesheet_flags.create` (low), `staff_tasks.create` (low) |
| `trades-after-hours-handover-summary` | suggest | email, web | `booking_requests.list` (low), `clients.list` (low) |
| `trades-after-hours-triage` | auto | voice, sms, web | `clients.list` (low), `booking_requests.create` (medium), `after_hours.page_on_call` (high), `safety.escalate_to_human` (high) |
| `trades-backflow-test-reminder` | auto | sms, email | `compliance_certificates.list` (low), `clients.get` (low), `compliance_reminders.send` (critical), `booking_requests.create` (medium) |
| `trades-booking-confirmation` | auto | sms, email, voice | `booking_requests.get` (low), `booking_requests.update` (medium), `project_visits.list` (low), `customer_messages.send` (critical) |
| `trades-compliance-certificate-reminders` | auto | email, sms | `compliance_certificates.list` (low), `clients.get` (low), `compliance_reminders.send` (critical), `booking_requests.create` (medium) |
| `trades-electrical-test-certificate-tracker` | suggest | web | `compliance_certificates.list` (low), `properties.list` (low) |
| `trades-gas-compliance-tracker` | suggest | web | `compliance_certificates.list` (low), `properties.list` (low) |
| `trades-gas-electrical-safety-escalation` | suggest | voice, sms, chat, web | `booking_requests.list` (low), `clients.list` (low), `safety.escalate_to_human` (high) |
| `trades-job-completion-follow-up` | auto | sms, email | `visits.get` (low), `projects.get` (low), `customer_messages.send` (critical), `property_issues.create` (medium) |
| `trades-job-completion-readiness` | suggest | web | `work_orders.list` (low), `visits.get` (low), `projects.get` (low), `compliance_certificates.list` (low) |
| `trades-job-notes-summariser` | suggest | web | `visits.get` (low), `projects.get` (low), `work_notes.list` (low) |
| `trades-job-scheduling-coordinator` | auto | sms, email, web | `projects.list` (low), `project_visits.list` (low), `work_orders.list` (low), `users.list` (low), `project_visits.bulk` (high) |
| `trades-parts-and-materials-check` | suggest | web | `projects.get` (low), `work_orders.list` (low), `inventory.stock.list` (low), `parts_list.draft` (medium) |
| `trades-quote-drafting-assist` | auto | web | `booking_requests.get` (low), `estimates.list` (low), `estimates.create` (high) |
| `trades-quote-follow-up` | auto | sms, email | `estimates.list` (low), `booking_requests.update` (medium), `customer_messages.send` (critical) |
| `trades-quote-request-intake` | auto | web, sms, email, chat, voice | `clients.list` (low), `estimates.list` (low), `booking_requests.create` (medium) |
| `trades-reschedule-and-access-handler` | auto | sms, voice, email, chat | `project_visits.list` (low), `clients.get` (low), `visits.update` (high), `customer_messages.send` (critical) |
| `trades-review-request` | auto | sms, email | `projects.get` (low), `clients.get` (low), `customer_messages.send` (critical) |
| `trades-seasonal-maintenance-reminder` | auto | email, sms | `clients.list` (low), `projects.get` (low), `customer_messages.send` (critical), `booking_requests.create` (medium) |
| `trades-service-agreement-lapse-watch` | suggest | web | `service_agreements.list` (low) |
| `trades-service-agreement-renewal` | auto | email, sms, voice | `service_agreements.list` (low), `clients.get` (low), `service_agreements.draft_renewal` (medium), `customer_messages.send` (critical) |
| `trades-supplier-order-draft` | suggest | web | `parts_lists.list` (low), `inventory.stock.list` (low), `purchase_orders.draft` (high) |
| `trades-technician-dispatch-support` | suggest | web | `users.list` (low), `work_orders.list` (low), `project_visits.list` (low), `projects.get` (low) |
| `trades-urgent-callout-triage` | auto | voice, sms, chat, web | `clients.list` (low), `booking_requests.create` (medium), `booking_requests.update` (medium), `safety.escalate_to_human` (high) |
| `trades-warranty-callback-triage` | auto | voice, sms, email, web | `clients.get` (low), `projects.get` (low), `property_issues.list` (low), `property_issues.create` (medium), `property_issues.update` (medium) |
| `warranty-callback-intake` | auto | email, web, sms | `projects.get` (low), `work_orders.list` (low), `property_issues.list` (low), `property_issues.create` (medium), `clients.get` (low), `customer_messages.draft` (low), `staff_tasks.create` (low) |
| `weekly-business-report` | suggest | email | `reports.weekly_summary` (low), `invoices.list` (low), `payments.list` (low), `projects.list` (low), `estimates.list` (low), `booking_requests.list` (low) |
| `window-cleaning-quote-follow-up` | auto | sms, email | `quotes.list` (low), `clients.list` (low), `messages.send` (critical) |
| `window-cleaning-scheduler` | auto | sms, voice, email | `sites.list` (low), `availability.read` (low), `service_visits.schedule` (medium), `service_visits.reschedule` (high) |

## Tool table

Read/write is a name-only guess. Handler column: `none` means no reference in `server/` outside roles; `docs only` means a mention in schema documentation.

| Tool | Read/write (guess) | Handler outside roles | Declared by (role: risk) |
|---|---|---|---|
| `after_hours.page_on_call` | write | none | `trades-after-hours-triage`: high |
| `agreements.list` | read | none | `membership-renewal`: low |
| `agreements.renewal_draft` | write | none | `membership-renewal`: low |
| `availability.read` | read | none | `carpet-upholstery-job-scheduler`: low; `cleaning-booking-coordinator`: low; `cleaning-crew-roster-coordinator`: low; `commercial-cleaning-site-visit-scheduler`: low; `end-of-lease-clean-coordinator`: low; `home-cleaning-recurring-scheduler`: low; `pool-booking-coordinator`: low; `pool-service-scheduler`: low; `pool-water-testing-scheduler`: low; `window-cleaning-scheduler`: low |
| `booking_requests.create` | write | schema docs only | `cleaning-booking-coordinator`: medium; `cleaning-enquiry-reception`: medium; `end-of-lease-clean-coordinator`: medium; `field-job-intake`: medium; `field-rebooking-reminder`: medium; `garden-after-hours-emergency-triage`: medium; `garden-irrigation-fault-triage`: medium; `garden-irrigation-repair-scheduler`: medium; `garden-job-completion-follow-up`: medium; `garden-landscape-design-quote-intake`: medium; `garden-lawn-mowing-scheduler`: medium; `garden-maintenance-plan-enrolment`: medium; `locksmith-lockout-intake`: medium; `pest-inspection-booking`: medium; `pest-reinspection-scheduler`: medium; `pest-treatment-follow-up`: medium; `pest-wildlife-callout-intake`: medium; `pool-booking-coordinator`: medium; `pool-enquiry-reception`: medium; `service-due-reminder`: medium; `trades-after-hours-triage`: medium; `trades-backflow-test-reminder`: medium; `trades-compliance-certificate-reminders`: medium; `trades-quote-request-intake`: medium; `trades-seasonal-maintenance-reminder`: medium; `trades-urgent-callout-triage`: medium |
| `booking_requests.get` | read | none | `garden-booking-change-handler`: low; `handyman-job-scoping`: low; `locksmith-escalation-brief`: low; `new-customer-onboarding`: low; `trades-booking-confirmation`: low; `trades-quote-drafting-assist`: low |
| `booking_requests.list` | read | schema docs only | `appointment-reminder`: low; `cleaning-booking-coordinator`: low; `cleaning-customer-care`: low; `field-job-intake`: low; `garden-booking-change-handler`: low; `garden-irrigation-repair-scheduler`: low; `garden-lawn-mowing-scheduler`: low; `pest-inspection-booking`: low; `pool-booking-coordinator`: low; `staff-roster-suggestions`: low; `trades-after-hours-handover-summary`: low; `trades-gas-electrical-safety-escalation`: low; `weekly-business-report`: low |
| `booking_requests.update` | write | none | `cleaning-booking-coordinator`: high; `field-no-show-follow-up`: medium; `garden-booking-change-handler`: medium; `garden-quote-chaser`: medium; `handyman-job-scoping`: medium; `no-show-follow-up`: medium; `pest-quote-follow-up`: medium; `pest-reinspection-scheduler`: medium; `pool-booking-coordinator`: high; `trades-booking-confirmation`: medium; `trades-quote-follow-up`: medium; `trades-urgent-callout-triage`: medium |
| `campaign_messages.create` | write | none | `garden-mulch-seasonal-campaign`: critical; `garden-seasonal-reminder`: critical; `garden-weed-control-seasonal-campaign`: critical; `pest-seasonal-reminder`: critical |
| `client_duplicates.list` | read | none | `customer-data-hygiene`: low |
| `client_merge_suggestions.create` | write | none | `customer-data-hygiene`: critical |
| `clients.create` | write | none | `garden-landscape-design-quote-intake`: high; `garden-tree-lopping-quote-intake`: high; `new-customer-onboarding`: medium |
| `clients.get` | read | none | `appointment-reminder`: low; `collections-follow-up`: low; `complaint-triage`: low; `dispute-intake`: low; `field-customer-care-recovery`: low; `field-quote-follow-up`: low; `field-review-request`: low; `garden-booking-change-handler`: low; `garden-customer-feedback-survey`: low; `garden-irrigation-fault-triage`: low; `garden-irrigation-repair-scheduler`: low; `garden-lawn-mowing-scheduler`: low; `garden-maintenance-plan-enrolment`: low; `garden-mulch-seasonal-campaign`: low; `garden-quote-chaser`: low; `garden-weed-control-seasonal-campaign`: low; `handyman-warranty-callback`: low; `invoice-reminder`: low; `lapsed-customer-reactivation`: low; `locksmith-escalation-brief`: low; `locksmith-identity-verification`: low; `locksmith-rekey-quote`: low; `membership-renewal`: low; `new-customer-onboarding`: low; `no-show-follow-up`: low; `painting-quote-follow-up`: low; `payment-reconciliation-check`: low; `payment-reminder`: low; `pest-inspection-booking`: low; `pest-post-treatment-feedback`: low; `pest-quote-follow-up`: low; `pest-service-record-checker`: low; `pest-treatment-follow-up`: low; `post-job-check-in`: low; `quote-follow-up`: low; `referral-request`: low; `refund-triage`: low; `review-monitor`: low; `service-due-reminder`: low; `trades-backflow-test-reminder`: low; `trades-compliance-certificate-reminders`: low; `trades-reschedule-and-access-handler`: low; `trades-review-request`: low; `trades-service-agreement-renewal`: low; `trades-warranty-callback-triage`: low; `warranty-callback-intake`: low |
| `clients.list` | read | schema docs only | `carpet-upholstery-aftercare-follow-up`: low; `carpet-upholstery-quote-intake`: low; `cleaning-booking-coordinator`: low; `cleaning-customer-care`: low; `cleaning-enquiry-reception`: low; `cleaning-feedback-survey`: low; `cleaning-invoice-query-desk`: low; `cleaning-quote-intake`: low; `commercial-cleaning-outbound-prospecting`: low; `commercial-cleaning-site-visit-scheduler`: low; `customer-data-hygiene`: low; `end-of-lease-clean-coordinator`: low; `field-job-intake`: low; `field-rebooking-reminder`: low; `garden-after-hours-emergency-triage`: low; `garden-landscape-design-quote-intake`: low; `garden-lawn-mowing-scheduler`: low; `garden-maintenance-plan-enrolment`: low; `garden-mulch-seasonal-campaign`: low; `garden-seasonal-reminder`: low; `garden-tree-lopping-quote-intake`: low; `garden-weed-control-seasonal-campaign`: low; `home-cleaning-recurring-scheduler`: low; `lapsed-customer-reactivation`: low; `locksmith-lockout-intake`: low; `new-customer-onboarding`: low; `pest-seasonal-reminder`: low; `pest-wildlife-callout-intake`: low; `pool-booking-coordinator`: low; `pool-customer-care`: low; `pool-enquiry-reception`: low; `pool-water-quality-escalation`: low; `trades-after-hours-handover-summary`: low; `trades-after-hours-triage`: low; `trades-gas-electrical-safety-escalation`: low; `trades-quote-request-intake`: low; `trades-seasonal-maintenance-reminder`: low; `trades-urgent-callout-triage`: low; `window-cleaning-quote-follow-up`: low |
| `collection_notes.create` | write | none | `collections-follow-up`: low; `payment-reminder`: low |
| `complaints.create` | write | none | `carpet-upholstery-aftercare-follow-up`: medium; `cleaning-customer-care`: medium; `pool-customer-care`: medium; `pool-water-quality-escalation`: medium |
| `compliance_certificates.list` | read | none | `trades-backflow-test-reminder`: low; `trades-compliance-certificate-reminders`: low; `trades-electrical-test-certificate-tracker`: low; `trades-gas-compliance-tracker`: low; `trades-job-completion-readiness`: low |
| `compliance_documents.list` | read | none | `compliance-expiry-tracker`: low |
| `compliance_reminders.send` | write | none | `trades-backflow-test-reminder`: critical; `trades-compliance-certificate-reminders`: critical |
| `crew_rosters.list` | read | none | `cleaning-crew-roster-coordinator`: low |
| `crew_rosters.update` | write | none | `cleaning-crew-roster-coordinator`: high |
| `customer_messages.draft` | write | none | `appointment-reminder`: low; `collections-follow-up`: low; `complaint-triage`: low; `dispute-intake`: low; `invoice-reminder`: low; `lapsed-customer-reactivation`: low; `membership-renewal`: low; `new-customer-onboarding`: low; `no-show-follow-up`: low; `payment-reminder`: low; `post-job-check-in`: low; `quote-follow-up`: low; `referral-request`: low; `service-due-reminder`: low; `warranty-callback-intake`: low |
| `customer_messages.send` | write | none | `appointment-reminder`: critical; `collections-follow-up`: critical; `dispute-intake`: critical; `invoice-reminder`: critical; `lapsed-customer-reactivation`: critical; `membership-renewal`: critical; `new-customer-onboarding`: critical; `no-show-follow-up`: critical; `payment-reminder`: critical; `post-job-check-in`: critical; `quote-follow-up`: critical; `referral-request`: critical; `service-due-reminder`: critical; `trades-booking-confirmation`: critical; `trades-job-completion-follow-up`: critical; `trades-quote-follow-up`: critical; `trades-reschedule-and-access-handler`: critical; `trades-review-request`: critical; `trades-seasonal-maintenance-reminder`: critical; `trades-service-agreement-renewal`: critical |
| `disputes.create` | write | none | `dispute-intake`: medium |
| `end_of_lease_checklists.create` | write | none | `end-of-lease-clean-coordinator`: medium |
| `escalations.create` | write | none | `carpet-upholstery-aftercare-follow-up`: low; `cleaning-customer-care`: low; `cleaning-feedback-survey`: low; `pool-customer-care`: low; `pool-water-quality-escalation`: low |
| `estimates.create` | write | none | `garden-landscape-design-quote-intake`: high; `garden-tree-lopping-quote-intake`: high; `locksmith-rekey-quote`: medium; `trades-quote-drafting-assist`: high |
| `estimates.list` | read | none | `field-quote-follow-up`: low; `garden-quote-chaser`: low; `locksmith-rekey-quote`: low; `painting-quote-follow-up`: low; `pest-quote-follow-up`: low; `quote-follow-up`: low; `trades-quote-drafting-assist`: low; `trades-quote-follow-up`: low; `trades-quote-request-intake`: low; `weekly-business-report`: low |
| `feedback_responses.create` | write | none | `garden-customer-feedback-survey`: medium; `pest-post-treatment-feedback`: medium |
| `feedback_surveys.send` | write | none | `cleaning-feedback-survey`: critical |
| `human_escalation.create` | write | none | `locksmith-arrival-check`: low; `locksmith-escalation-brief`: low; `locksmith-identity-verification`: low; `locksmith-lockout-intake`: low |
| `identity.verify_request` | write | none | `locksmith-identity-verification`: critical |
| `inventory.list` | read | none | `stock-reorder-suggestions`: low |
| `inventory.stock.list` | read | none | `trades-parts-and-materials-check`: low; `trades-supplier-order-draft`: low |
| `invoice_disputes.create` | write | none | `cleaning-invoice-query-desk`: medium |
| `invoices.get` | read | none | `collections-follow-up`: low; `dispute-intake`: low; `invoice-reminder`: low; `payment-reminder`: low; `refund-triage`: low |
| `invoices.list` | read | none | `cleaning-invoice-query-desk`: low; `collections-follow-up`: low; `invoice-reminder`: low; `payment-reconciliation-check`: low; `payment-reminder`: low; `weekly-business-report`: low |
| `job_checklists.list` | read | none | `cleaning-post-visit-quality-check`: low |
| `job_notes.create` | write | none | `field-technician-checkout`: low |
| `job_photos.list` | read | none | `cleaning-post-visit-quality-check`: low; `field-job-photo-request`: low |
| `job_photos.request_from_customer` | write | none | `handyman-job-scoping`: critical |
| `job_signoff.record` | write | none | `field-signoff-request`: high |
| `job_signoff.request` | write | none | `field-signoff-request`: critical |
| `maintenance_plans.create` | write | none | `garden-maintenance-plan-enrolment`: high |
| `materials.check` | read | none | `field-materials-parts-reminder`: low; `painting-site-prep-checklist`: low |
| `messages.draft_customer` | write | none | `field-customer-care-recovery`: low; `field-customer-status-update`: low; `field-eta-delay-notice`: low; `field-no-show-follow-up`: low; `field-quote-follow-up`: low; `field-schedule-change`: low; `field-visit-confirmation`: low; `handyman-warranty-callback`: low; `painting-quote-follow-up`: low |
| `messages.send` | write | none | `carpet-upholstery-aftercare-follow-up`: critical; `cleaning-customer-care`: critical; `commercial-cleaning-outbound-prospecting`: critical; `garden-quote-chaser`: critical; `pest-quote-follow-up`: critical; `pool-customer-care`: critical; `window-cleaning-quote-follow-up`: critical |
| `messages.send_customer` | write | none | `field-customer-care-recovery`: critical; `field-customer-status-update`: critical; `field-eta-delay-notice`: critical; `field-no-show-follow-up`: critical; `field-quote-follow-up`: critical; `field-rebooking-reminder`: critical; `field-schedule-change`: critical; `field-visit-confirmation`: critical; `painting-quote-follow-up`: critical |
| `opportunities.create` | write | none | `commercial-cleaning-outbound-prospecting`: medium |
| `ownership.verify` | write | none | `locksmith-arrival-check`: high; `locksmith-identity-verification`: high |
| `parts_list.draft` | write | none | `trades-parts-and-materials-check`: medium |
| `parts_lists.list` | read | none | `trades-supplier-order-draft`: low |
| `payment_plans.propose` | write | none | `collections-follow-up`: critical |
| `payments.list` | read | none | `collections-follow-up`: low; `dispute-intake`: low; `payment-reconciliation-check`: low; `payment-reminder`: low; `refund-triage`: low; `weekly-business-report`: low |
| `pool_equipment.list` | read | none | `pool-equipment-fault-intake`: low; `pool-equipment-parts-quote-prep`: low |
| `pool_equipment_faults.create` | write | none | `pool-equipment-fault-intake`: medium |
| `pool_profiles.list` | read | none | `pool-booking-coordinator`: low; `pool-equipment-fault-intake`: low; `pool-service-scheduler`: low; `pool-water-quality-escalation`: low; `pool-water-testing-scheduler`: low |
| `project_visits.bulk` | write | none | `trades-job-scheduling-coordinator`: high |
| `project_visits.list` | read | none | `appointment-reminder`: low; `field-daily-schedule-brief`: low; `field-eta-delay-notice`: low; `field-no-show-follow-up`: low; `field-schedule-change`: low; `field-visit-confirmation`: low; `garden-booking-change-handler`: low; `garden-crew-route-planner`: low; `garden-irrigation-repair-scheduler`: low; `garden-job-dispatch-coordinator`: low; `garden-lawn-mowing-scheduler`: low; `garden-seasonal-reminder`: low; `no-show-follow-up`: low; `painting-site-prep-checklist`: low; `pest-inspection-booking`: low; `pest-reinspection-scheduler`: low; `pest-service-record-checker`: low; `staff-roster-suggestions`: low; `timesheet-check`: low; `trades-booking-confirmation`: low; `trades-job-scheduling-coordinator`: low; `trades-reschedule-and-access-handler`: low; `trades-technician-dispatch-support`: low |
| `projects.get` | read | none | `complaint-triage`: low; `field-customer-status-update`: low; `field-materials-parts-reminder`: low; `field-review-request`: low; `field-signoff-request`: low; `garden-job-dispatch-coordinator`: low; `handyman-warranty-callback`: low; `painting-site-prep-checklist`: low; `post-job-check-in`: low; `referral-request`: low; `trades-job-completion-follow-up`: low; `trades-job-completion-readiness`: low; `trades-job-notes-summariser`: low; `trades-parts-and-materials-check`: low; `trades-review-request`: low; `trades-seasonal-maintenance-reminder`: low; `trades-technician-dispatch-support`: low; `trades-warranty-callback-triage`: low; `warranty-callback-intake`: low |
| `projects.list` | read | none | `field-rebooking-reminder`: low; `garden-job-dispatch-coordinator`: low; `garden-service-history-reviewer`: low; `lapsed-customer-reactivation`: low; `staff-roster-suggestions`: low; `trades-job-scheduling-coordinator`: low; `weekly-business-report`: low |
| `properties.list` | read | none | `garden-crew-route-planner`: low; `new-customer-onboarding`: low; `service-due-reminder`: low; `trades-electrical-test-certificate-tracker`: low; `trades-gas-compliance-tracker`: low |
| `property_contacts.list` | read | none | `commercial-cleaning-site-visit-scheduler`: low; `end-of-lease-clean-coordinator`: low |
| `property_issues.create` | write | none | `complaint-triage`: medium; `field-customer-care-recovery`: medium; `garden-after-hours-emergency-triage`: medium; `garden-irrigation-fault-triage`: medium; `garden-job-completion-follow-up`: medium; `garden-tree-lopping-quote-intake`: medium; `handyman-warranty-callback`: medium; `pest-treatment-follow-up`: medium; `pest-wildlife-callout-intake`: medium; `trades-job-completion-follow-up`: medium; `trades-warranty-callback-triage`: medium; `warranty-callback-intake`: medium |
| `property_issues.list` | read | none | `complaint-triage`: low; `field-customer-care-recovery`: low; `garden-irrigation-fault-triage`: low; `garden-service-history-reviewer`: low; `trades-warranty-callback-triage`: low; `warranty-callback-intake`: low |
| `property_issues.update` | write | none | `trades-warranty-callback-triage`: medium |
| `purchase_orders.draft` | write | none | `trades-supplier-order-draft`: high |
| `purchase_orders.list` | read | none | `supplier-bill-check`: low |
| `quote_requests.create` | write | none | `carpet-upholstery-quote-intake`: medium; `cleaning-quote-intake`: medium; `pool-equipment-parts-quote-prep`: medium |
| `quotes.list` | read | none | `window-cleaning-quote-follow-up`: low |
| `referral_requests.create` | write | none | `referral-request`: low |
| `refund_requests.create` | write | none | `cleaning-invoice-query-desk`: critical |
| `refund_requests.list` | read | none | `refund-triage`: low |
| `refund_requests.prepare` | write | none | `refund-triage`: critical |
| `reports.weekly_summary` | read | none | `weekly-business-report`: low |
| `review_alerts.create` | write | none | `review-monitor`: low |
| `reviews.list` | read | none | `referral-request`: low; `review-monitor`: low |
| `reviews.request` | write | none | `field-review-request`: critical |
| `safety.escalate_to_human` | write | none | `trades-after-hours-triage`: high; `trades-gas-electrical-safety-escalation`: high; `trades-urgent-callout-triage`: high |
| `service_agreements.draft_renewal` | write | none | `trades-service-agreement-renewal`: medium |
| `service_agreements.list` | read | none | `trades-service-agreement-lapse-watch`: low; `trades-service-agreement-renewal`: low |
| `service_schedules.list` | read | none | `service-due-reminder`: low |
| `service_visits.list` | read | none | `carpet-upholstery-aftercare-follow-up`: low; `cleaning-crew-roster-coordinator`: low; `cleaning-customer-care`: low; `cleaning-feedback-survey`: low; `cleaning-post-visit-quality-check`: low; `home-cleaning-recurring-scheduler`: low; `pool-customer-care`: low; `pool-service-scheduler`: low |
| `service_visits.reschedule` | write | none | `carpet-upholstery-job-scheduler`: high; `home-cleaning-recurring-scheduler`: high; `pool-service-scheduler`: high; `window-cleaning-scheduler`: high |
| `service_visits.schedule` | write | none | `carpet-upholstery-job-scheduler`: medium; `home-cleaning-recurring-scheduler`: medium; `pool-equipment-fault-intake`: medium; `pool-service-scheduler`: medium; `window-cleaning-scheduler`: medium |
| `site_visits.schedule` | write | none | `commercial-cleaning-site-visit-scheduler`: medium |
| `sites.list` | read | none | `carpet-upholstery-job-scheduler`: low; `carpet-upholstery-quote-intake`: low; `cleaning-enquiry-reception`: low; `cleaning-quote-intake`: low; `commercial-cleaning-site-visit-scheduler`: low; `end-of-lease-clean-coordinator`: low; `pool-enquiry-reception`: low; `window-cleaning-scheduler`: low |
| `staff_tasks.create` | write | none | `appointment-reminder`: low; `collections-follow-up`: low; `complaint-triage`: low; `compliance-expiry-tracker`: low; `customer-data-hygiene`: low; `dispute-intake`: low; `invoice-reminder`: low; `lapsed-customer-reactivation`: low; `membership-renewal`: low; `new-customer-onboarding`: low; `no-show-follow-up`: low; `payment-reconciliation-check`: low; `post-job-check-in`: low; `quote-follow-up`: low; `referral-request`: low; `refund-triage`: low; `review-monitor`: low; `service-due-reminder`: low; `staff-roster-suggestions`: low; `stock-reorder-suggestions`: low; `supplier-bill-check`: low; `timesheet-check`: low; `warranty-callback-intake`: low |
| `supplier_bills.list` | read | none | `supplier-bill-check`: low |
| `technician_tasks.create` | write | none | `field-job-photo-request`: medium; `field-materials-parts-reminder`: medium |
| `timesheet_flags.create` | write | none | `timesheet-check`: low |
| `timesheets.list` | read | none | `timesheet-check`: low |
| `users.list` | read | none | `compliance-expiry-tracker`: low; `field-daily-schedule-brief`: low; `garden-crew-route-planner`: low; `garden-job-dispatch-coordinator`: low; `staff-roster-suggestions`: low; `timesheet-check`: low; `trades-job-scheduling-coordinator`: low; `trades-technician-dispatch-support`: low |
| `visits.get` | read | none | `field-customer-status-update`: low; `field-eta-delay-notice`: low; `field-no-show-follow-up`: low; `field-technician-checkin`: low; `field-technician-checkout`: low; `field-visit-confirmation`: low; `garden-crew-route-planner`: low; `garden-customer-feedback-survey`: low; `garden-job-completion-follow-up`: low; `garden-job-dispatch-coordinator`: low; `garden-service-history-reviewer`: low; `locksmith-arrival-check`: low; `no-show-follow-up`: low; `pest-post-treatment-feedback`: low; `pest-reinspection-scheduler`: low; `pest-service-record-checker`: low; `pest-treatment-follow-up`: low; `trades-job-completion-follow-up`: low; `trades-job-completion-readiness`: low; `trades-job-notes-summariser`: low |
| `visits.transition` | write | none | `field-technician-checkout`: medium |
| `visits.update` | write | none | `field-schedule-change`: high; `garden-job-dispatch-coordinator`: high; `trades-reschedule-and-access-handler`: high |
| `water_test_results.list` | read | none | `pool-water-testing-scheduler`: low |
| `water_tests.schedule` | write | none | `pool-water-testing-scheduler`: medium |
| `work_notes.list` | read | none | `trades-job-notes-summariser`: low |
| `work_orders.list` | read | none | `field-daily-schedule-brief`: low; `field-materials-parts-reminder`: low; `garden-job-completion-follow-up`: low; `garden-job-dispatch-coordinator`: low; `garden-service-history-reviewer`: low; `pest-seasonal-reminder`: low; `pest-service-record-checker`: low; `pest-treatment-follow-up`: low; `post-job-check-in`: low; `staff-roster-suggestions`: low; `trades-job-completion-readiness`: low; `trades-job-scheduling-coordinator`: low; `trades-parts-and-materials-check`: low; `trades-technician-dispatch-support`: low; `warranty-callback-intake`: low |
| `work_orders.start_visit` | write | none | `field-technician-checkin`: medium |

## Critical tools

Tools declared at `critical` risk by at least one role. Their handlers do not exist in `server/` (see the tool table).

| Tool | Read/write (guess) | Roles declaring it at critical |
|---|---|---|
| `campaign_messages.create` | write | `garden-mulch-seasonal-campaign`, `garden-seasonal-reminder`, `garden-weed-control-seasonal-campaign`, `pest-seasonal-reminder` |
| `client_merge_suggestions.create` | write | `customer-data-hygiene` |
| `compliance_reminders.send` | write | `trades-backflow-test-reminder`, `trades-compliance-certificate-reminders` |
| `customer_messages.send` | write | `appointment-reminder`, `collections-follow-up`, `dispute-intake`, `invoice-reminder`, `lapsed-customer-reactivation`, `membership-renewal`, `new-customer-onboarding`, `no-show-follow-up`, `payment-reminder`, `post-job-check-in`, `quote-follow-up`, `referral-request`, `service-due-reminder`, `trades-booking-confirmation`, `trades-job-completion-follow-up`, `trades-quote-follow-up`, `trades-reschedule-and-access-handler`, `trades-review-request`, `trades-seasonal-maintenance-reminder`, `trades-service-agreement-renewal` |
| `feedback_surveys.send` | write | `cleaning-feedback-survey` |
| `identity.verify_request` | write | `locksmith-identity-verification` |
| `job_photos.request_from_customer` | write | `handyman-job-scoping` |
| `job_signoff.request` | write | `field-signoff-request` |
| `messages.send` | write | `carpet-upholstery-aftercare-follow-up`, `cleaning-customer-care`, `commercial-cleaning-outbound-prospecting`, `garden-quote-chaser`, `pest-quote-follow-up`, `pool-customer-care`, `window-cleaning-quote-follow-up` |
| `messages.send_customer` | write | `field-customer-care-recovery`, `field-customer-status-update`, `field-eta-delay-notice`, `field-no-show-follow-up`, `field-quote-follow-up`, `field-rebooking-reminder`, `field-schedule-change`, `field-visit-confirmation`, `painting-quote-follow-up` |
| `payment_plans.propose` | write | `collections-follow-up` |
| `refund_requests.create` | write | `cleaning-invoice-query-desk` |
| `refund_requests.prepare` | write | `refund-triage` |
| `reviews.request` | write | `field-review-request` |
