
const { Pool } = require('pg');
require('dotenv').config();

// Local logger. This script runs under plain Node and cannot import server/utils/logger.ts,
// so it writes the same level prefixes as that logger (development format).
const writeLog = (stream, prefix, parts) => stream.write(`${prefix} ${parts.join(" ")}\n`);
const log = {
  info: (...parts) => writeLog(process.stdout, "[INFO] ", parts),
  warn: (...parts) => writeLog(process.stderr, "[WARN] ", parts),
  error: (...parts) => writeLog(process.stderr, "[ERROR]", parts),
};

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    log.error("Error: DATABASE_URL environment variable is not set.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: connectionString,
});

async function run() {
    const client = await pool.connect();
    try {
        log.info("Connecting to the database...");

        // Drop the foreign key constraint on campaigns.agent_id
        log.info("Dropping campaigns_agent_id_agents_id_fk constraint...");
        await client.query(`
      ALTER TABLE campaigns 
      DROP CONSTRAINT IF EXISTS campaigns_agent_id_agents_id_fk;
    `);

        log.info("Successfully updated the database!");
    } catch (error) {
        log.error("Database update failed:", error);
    } finally {
        client.release();
        await pool.end();
    }
}

run();
