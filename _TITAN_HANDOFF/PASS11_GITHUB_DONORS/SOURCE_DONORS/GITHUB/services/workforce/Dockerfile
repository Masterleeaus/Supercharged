FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production
ENV WORKFORCE_PORT=3010
EXPOSE 3010
CMD ["services/workforce/node_modules/.bin/tsx", "--tsconfig", "apps/web/tsconfig.json", "services/workforce/src/server.ts"]
