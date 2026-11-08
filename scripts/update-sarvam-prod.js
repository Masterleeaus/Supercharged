// update-sarvam-prod.js
// Run this on your production server: node update-sarvam-prod.js
import pg from 'pg';
import dotenv from 'dotenv';

// Load .env if present
dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("❌ Error: DATABASE_URL environment variable is not set.");
  console.error("Please run this command with the DATABASE_URL set, or run it in the directory with your production .env file.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });

async function main() {
  console.log("Connecting to the production database...");
  const client = await pool.connect();
  try {
    const result = await client.query(`
      UPDATE settings 
      SET value = '"bulbul:v3"' 
      WHERE key = 've_tts_sarvam_model'
      RETURNING *;
    `);
    
    if (result.rowCount > 0) {
      console.log("✅ Successfully updated ve_tts_sarvam_model to bulbul:v3 in the live database!");
      console.log("Updated row:", result.rows[0]);
    } else {
      // If the global settings table is named something else, try global_settings
      const globalResult = await client.query(`
        UPDATE global_settings 
        SET value = '"bulbul:v3"' 
        WHERE key = 've_tts_sarvam_model'
        RETURNING *;
      `).catch(() => ({ rowCount: 0 }));
      
      if (globalResult.rowCount > 0) {
         console.log("✅ Successfully updated ve_tts_sarvam_model to bulbul:v3 in the global_settings table!");
      } else {
         console.log("⚠️ Could not find the ve_tts_sarvam_model setting in the database.");
      }
    }
  } catch (error) {
    console.error("❌ Database update failed:", error);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
