FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && addgroup -S trustsocial && adduser -S trustsocial -G trustsocial
COPY --from=builder /app/dist ./dist
COPY public ./public
# Where the SQLite file and any locally-served media live - mounted as a volume
# in docker-compose.yml so it survives container recreation.
RUN mkdir -p /data && chown -R trustsocial:trustsocial /data /app
USER trustsocial
ENV TRUSTSOCIAL_DB_PATH=/data/trustsocial.db
EXPOSE 4400
# Uses Node's built-in fetch instead of curl/wget so the image doesn't need either installed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4400/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
