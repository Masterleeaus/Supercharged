#!/bin/bash
set -e

echo "📦 Code already synced from GitHub Actions — skipping git pull."

echo "🔎 Checking Node version (Node 22 required)..."
node -e 'if (process.versions.node.split(".")[0] !== "22") { console.error("Node 22 is required, found " + process.versions.node); process.exit(1); }'

echo "📦 Installing dependencies..."
npm install

echo "🔧 Building TypeScript..."
npm run build

echo "🔌 Building plugin backend..."
node scripts/build-plugin-backend.js

echo "🚀 Restarting PM2 (app listens on port 5000)..."
pm2 restart agentlabs || pm2 start npm --name "agentlabs" -- run start

echo "🎉 Deployment finished!"