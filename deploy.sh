#!/bin/bash
set -e

echo "📦 Code already synced from GitHub Actions — skipping git pull."

echo "📦 Installing dependencies..."
npm install

echo "🔧 Building TypeScript..."
npm run build

echo "🔌 Building plugin backend..."
node scripts/build-plugin-backend.js

echo "🚀 Restarting PM2..."
pm2 restart agentlabs || pm2 start npm --name "agentlabs" -- run start

echo "🎉 Deployment finished!"