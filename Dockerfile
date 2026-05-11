# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate \
 && npm run build \
 && npm prune --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

RUN apk add --no-cache curl tini \
 && addgroup -S zuno -g 1001 \
 && adduser -S zuno -u 1001 -G zuno

COPY --from=build --chown=zuno:zuno /app/node_modules ./node_modules
COPY --from=build --chown=zuno:zuno /app/dist ./dist
COPY --from=build --chown=zuno:zuno /app/prisma ./prisma
COPY --from=build --chown=zuno:zuno /app/package.json ./package.json

USER zuno
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/v1/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
