#!/bin/bash
# Script to add classification column to ve_sessions table

# Read the connection URL from the environment; never commit credentials here.
DB_URL="${COMPASSAPP_DB_URL:?Set COMPASSAPP_DB_URL to the PostgreSQL connection URL}"

echo "Adding 'classification' column to 've_sessions' table..."
psql "$DB_URL" -c "ALTER TABLE ve_sessions ADD COLUMN IF NOT EXISTS classification TEXT;"

if [ $? -eq 0 ]; then
  echo "✅ Column added successfully!"
else
  echo "❌ Failed to add column. Check credentials or connection."
fi
