// Script to update production DB
// Run with: node scripts/update-db-prod.js
// Make sure DATABASE_URL is set in your environment or .env file

const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("Error: DATABASE_URL environment variable is not set.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: connectionString,
});

async function run() {
  const client = await pool.connect();
  try {
    console.log("Connecting to the database...");
    
    // Drop the foreign key constraint on campaigns.agent_id
    console.log("Dropping campaigns_agent_id_agents_id_fk constraint...");
    await client.query(`
      ALTER TABLE campaigns 
      DROP CONSTRAINT IF EXISTS campaigns_agent_id_agents_id_fk;
    `);
    
    console.log("Successfully updated the database!");
  } catch (error) {
    console.error("Database update failed:", error);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
