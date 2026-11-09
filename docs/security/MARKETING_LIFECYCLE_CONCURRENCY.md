# Marketing lifecycle: conditional writes (Pass 9)

The Marketing service checks current status before writing, but two requests can race. The SQL adapter must also restrict its UPDATE by expected prior status.

* Draft page edits and publication require `status='draft'`.
* Page archive requires status not already archived.
* Draft content edits and approval require `status='draft'`.
* Content publication requires `status='approved'`.

If the SQL UPDATE returns no row, the service returns a **409 conflict** rather than incorrectly returning its stale, pre-UPDATE entity.

This addresses lifecycle race windows at the application SQL boundary. Real multi-connection PostgreSQL tests are still required before production activation.
