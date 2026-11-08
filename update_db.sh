#!/bin/bash
# Script to add classification column to ve_sessions table

DB_URL="postgresql://compassapp_user:compassapp0923647423@localhost:5432/compassapp_db"

echo "Adding 'classification' column to 've_sessions' table..."
psql "$DB_URL" -c "ALTER TABLE ve_sessions ADD COLUMN IF NOT EXISTS classification TEXT;"

if [ $? -eq 0 ]; then
  echo "✅ Column added successfully!"
else
  echo "❌ Failed to add column. Check credentials or connection."
fi
