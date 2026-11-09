# Rollout / rollback for mode navigation

1. Verify the trusted communications host maps to `comms` in `/api/desk-mode`; reject unexpected hosts.
2. Keep `VITE_ENABLE_CHATBOT_INBOX` disabled until the server's chatbot agent routes, database, session company-scope checks and staff permissions are independently verified.
3. Once verified, deploy server routes and matching client flag together; test both deep links and reload on the communications host.
4. Test an unrelated workforce host: it must show a mode-unavailable explanation and fail server route guards. Test an unauthenticated request and two distinct companies.
5. Confirm marketer and staff actions are limited by roles at the API, not merely by sidebar visibility.
6. Roll back by disabling `VITE_ENABLE_CHATBOT_INBOX` and redeploying the client; leave existing server guards in place.

The implementation does not enable unverified providers, change central identity, or change tenant keys.

7. Test unknown hosts and repeated Host values: /api/desk-mode must return 404, regardless of X-Forwarded-Host.
8. Require `source: "host"` in the client before treating a mode as available.
