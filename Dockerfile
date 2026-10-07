FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY tools/vendor/jobtracker-next-root-glob-1.0.0.tgz tools/vendor/jobtracker-next-root-glob-1.0.0.tgz
RUN npm ci

FROM dependencies AS build
COPY . .
# Build-only synthetic values: never inject local credentials or require a live database.
RUN NODE_ENV=production \
    DATABASE_URL=postgresql://build:build-only-password@127.0.0.1:9/build \
    ENCRYPTION_SECRET=build-only-encryption-secret-0000000000000000 \
    APP_ACCESS_TOKEN=build-only-access-token-00000000000000000000 \
    APP_BASE_URL=https://build.invalid CORS_ALLOWED_ORIGINS=https://build.invalid \
    LOCAL_DOCKER_HTTP_ENABLED=0 APPLICATION_WRITES_ENABLED=0 \
    APPLICATION_IDENTITY_WRITES_ENABLED=0 VALIDATION_MANUAL_ENTRY_ENABLED=0 \
    NEXT_TELEMETRY_DISABLED=1 npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["node", "scripts/local-container-start.mjs"]
