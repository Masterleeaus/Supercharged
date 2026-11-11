# Stage 1: build. Needs devDependencies (vite, esbuild, typescript) for `npm run build`.
FROM node:22 AS build

WORKDIR /app

# Copy only package files first (this layer caches independently).
# packages/ is needed here too: package.json depends on "file:packages/diploy-core".
COPY package*.json ./
COPY packages ./packages

# Install all dependencies, including devDependencies, for the build
RUN npm ci

# Copy source code - invalidates cache only when code changes
COPY . .

# Build client (dist/public) and server (dist/index.js)
RUN npm run build

# Stage 2: runtime. Production dependencies only, plus the built output and
# the runtime files the server reads from the working directory.
FROM node:22 AS runtime

WORKDIR /app

ENV NODE_ENV=production
# server/index.ts reads PORT and falls back to 5000. Keep EXPOSE in step with it.
ENV PORT=5000

COPY package*.json ./
COPY packages ./packages
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Compiled server deps used by plugins in production (written by scripts/build-server-deps.js)
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
# Plugins are loaded from process.cwd()/plugins
COPY --from=build /app/plugins ./plugins
# Static assets served from process.cwd(): public/ (widget, audio) and client/public (uploads, images)
COPY --from=build /app/public ./public
COPY --from=build /app/client/public ./client/public

# Run as a dedicated unprivileged user. Code and dependencies stay root-owned and read-only
# to the app user; only the directories the server writes to at runtime are handed over.
# kyc, exports, data, logs, public/images, public/audio: created by server/utils/init-directories.ts
# public: sitemap.xml and audio are written under public/ and client/public/
# plugins: written by the plugin installer
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --create-home --home-dir /home/app --shell /usr/sbin/nologin app \
 && mkdir -p kyc exports data/invoices data/refund-notes logs public/images public/audio \
 && chown -R app:app kyc exports data logs public/images public/audio client/public/uploads plugins \
 && chown app:app public client/public

USER app

EXPOSE 5000

CMD ["npm", "start"]
