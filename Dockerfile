# Image produksi untuk Render (atau PaaS lain tanpa akses Docker daemon):
# API + worker + frontend dalam satu container, agent dijalankan dengan runner "process".
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*
# Pin versi CLI agent; naikkan secara sadar setelah dites.
RUN npm install -g @anthropic-ai/claude-code@2.1.304 @openai/codex@0.163.0 && npm cache clean --force
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/ ./
COPY --from=web /app/web/dist /app/web/dist
RUN mkdir -p /var/lib/ruang/agents
ENV NODE_ENV=production \
    WEB_DIST=/app/web/dist \
    AGENT_RUNNER=process \
    AGENT_DATA_DIR=/var/lib/ruang/agents \
    WORKER_CONCURRENCY=2
# Tetap root: runner "process" butuh root untuk menjalankan tiap agent sebagai user Linux berbeda.
EXPOSE 10000
CMD ["node", "--import", "tsx", "src/all.ts"]
