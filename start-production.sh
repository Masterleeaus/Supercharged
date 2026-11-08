#!/bin/bash
set -e

cd /home/admin/apps/desk

export PATH="/home/admin/.nvm/versions/node/v20.20.2/bin:$PATH"
export NODE_ENV=production
export PORT=3001
export APP_PORT=3001

exec /home/admin/.nvm/versions/node/v20.20.2/bin/node \
    /home/admin/apps/desk/dist/index.js
