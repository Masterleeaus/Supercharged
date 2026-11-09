# Marketing and Omnichannel Inbox — source boundaries

Issue #52 implementation pass: the authenticated server `GET /api/desk-mode` remains the sole mode discovery source. The server's `comms` mode contains two user-visible destinations: **Marketing** and **Omnichannel Inbox**. These are not independently authorized tenant identities.

- UI entry points: `/app/modes/marketing` and `/app/modes/inbox`.
- Inbox UI: `/app/chatbot-inbox`, behind `VITE_ENABLE_CHATBOT_INBOX=true` and authenticated mode lookup.
- The mode selector is URL-based so reloading a destination retains the selection. It never persists a company ID.
- Company identity and roles must be resolved by server auth/session middleware for all data operations; UI-only guards are not sufficient.
- The feature gate and mode guard return informative unavailable screens instead of accidentally advertising a working inbox.
- The existing server host-based module guards remain authoritative for guarded APIs.

**Not complete:** company-specific capability provisioning, authorized company switching, comprehensive server enforcement of every marketing/inbox API and a live channel integration test. This work does not close #52.
