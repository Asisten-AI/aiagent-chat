# Image sandbox tempat setiap run agent dijalankan.
# Satu container per run, dihapus setelah selesai. File kerja & session
# disimpan di named volume per (agent, channel) yang di-mount ke /home/agent.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*
# Pin versi agar build bisa diulang; naikkan secara sadar setelah dites.
RUN npm install -g @anthropic-ai/claude-code@2.1.304 @openai/codex@0.163.0
RUN useradd -m -u 10001 agent && mkdir -p /home/agent/work && chown -R agent:agent /home/agent
USER agent
WORKDIR /home/agent/work
