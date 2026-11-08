# Pass 8 interface contract for the separate database integration agent

**This document describes interface requirements only. Pass 8 makes zero
schema, SQL, migration, database connection, or ledger implementation changes.**

The existing Field->Desk intent receiver still needs:
- `resolveCompany(companyId)`: trusted active company-to-Desk identity binding.
- `verifyConsent({intent,mapping})`: current verified communication consent, not an older cached claim.
- `claimEvent({companyId,eventId,payloadHash,correlationId,intent,deskUserId})`: durable atomic company-scoped idempotency claim. Return `claimed`, `duplicate` with matching completed receipt and hash, `conflict`, or `unavailable`.
- `recordResult({intent,mapping,receipt})`: persist the exact simulated delivery outcome, atomically linked to claim.

The **new** Desk->Field reply proposal receiver requires:
- `resolveDeskIdentity({deskUserId,companyId})`: an authenticated, active company/Desk account binding. Return `{company_id,desk_user_id,active:true}` or null.
- `verifyFieldResource({binding,proposal})`: check company, client, resource and current access against authoritative Field ownership. Return strict boolean `true` only when verified.
- `claimProposal({companyId,eventId,payloadHash,correlationId,deskUserId})`: durable atomic company-scoped claim. Duplicate same hash requires completed receipt. Conflicting hash must fail.
- `recordProposal({proposal,action,receipt,binding})`: persist proposal for explicit human/governed review **without performing the proposed action**, and atomically associate the receipt with the ledger claim. An opt-out notice must be escalated urgently; do not infer it has already revoked consent.

The **new** Desk intake orchestrator requires adapters from approved existing Desk provider infrastructure:
- `verifyProviderEvent(providerInput)`: verify authentic provider webhook/connection, and return a new trusted provider summary with `verified:true`, `provider`, `provider_event_reference`, `conversation_reference`, `desk_record_reference`, `channel`, and original provider `occurred_at` timestamp. **Do not forward raw messages or return the caller JSON verbatim.**
- `resolveFieldContext(verified)`: trusted company/Desk identity + current Field resource and client mapping. Never select a first owner or derive the company from a user-supplied query field.
- `classify(verified)`: bounded category plus classifier version. Classifier is non-authoritative; only allowed categories are accepted.
- `submitProposal(proposal)`: signed HTTP transport using Desk's reply-sender. It must verify the returned non-executing receipt.

**Operational rules:**
1. No cross-database queries or persistence implementation in the Field or Desk application bridge modules.
2. No automatic SMS, email, booking, invoice, refund, dispatch, or consent state change in Pass 8.
3. Protect symmetric keys; rotate independently for each direction. Never print keys or raw body in logs.
4. Forward route and reverse route are disabled without explicit environment flags and all required ports.
5. Treat all source snapshots as incomplete deployment backups until reconciled against live host and latest GitHub commit.
