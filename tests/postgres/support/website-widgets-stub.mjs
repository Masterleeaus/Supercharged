// Licence: original TitanZero test code. No Mastra or VoltAgent source is copied.
// Test-only stub so migration 0026 can ALTER website_widgets in the CI tenant fixture (issue #253 ratchet).
// The base schema (0000) is not applied in that job. Not created when the real table exists.
// Columns match what 0026 reads: id and user_id.
export async function ensureWebsiteWidgetsStub(client) {
  await client.query('CREATE TABLE IF NOT EXISTS website_widgets (id varchar PRIMARY KEY, user_id varchar)');
}
