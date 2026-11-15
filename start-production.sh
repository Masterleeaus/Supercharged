#!/bin/bash
set -e

cd /home/admin/apps/desk

# Production target is Node 22 and port 5000, matching the Dockerfile.
# NODE_BIN may point at a Node 22 binary; otherwise the first `node` on PATH is used.
NODE_BIN="${NODE_BIN:-node}"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" != "22" ]; then
    echo "start-production.sh: Node 22 is required, found major version $NODE_MAJOR" >&2
    exit 1
fi

export NODE_ENV=production
export PORT=5000
export APP_PORT=5000

exec "$NODE_BIN" \
    /home/admin/apps/desk/dist/index.js
