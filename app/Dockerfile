# Sidekick web app (client portal, Owner Console, Teams bot endpoint) as one container.
# Build:  docker build -t sidekick ./app        (or in Azure: az acr build -t sidekick ./app)
# Run:    docker run -p 8080:8080 --env-file <your env file> sidekick
# Required at run time: DATABASE_URL (Postgres) and ANTHROPIC_API_KEY; plus CLIENT_ID/CLIENT_SECRET/TENANT_ID
# for Teams and AZURE_* for Azure AI Search. Secrets are passed in at run time, never baked into the image.

# 1. Install dependencies (cached unless package files change).
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 2. Build the production bundle ("standalone": a small server.js plus only the files it needs).
FROM node:26-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx next build

# 3. The image that runs: no source code, no dev tools, runs as the unprivileged "node" user.
FROM node:26-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/db ./db
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
