FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=10000 \
    DATA_DIR=/var/data

WORKDIR /app
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /var/data/runs /var/data/game-logs \
    && chown -R app:app /var/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public

USER app
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["npm", "start"]
