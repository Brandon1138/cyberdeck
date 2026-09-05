FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
# Base digest and provider versions are fixed. Build logs record apt package versions.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates bash procps && rm -rf /var/lib/apt/lists/*
RUN npm install --global @anthropic-ai/claude-code@2.1.261 @openai/codex@0.153.4 pnpm@11.5.0 && npm cache clean --force
RUN usermod --login worker node && groupmod --new-name worker node && usermod --home /home/worker worker && mkdir -p /home/worker /workspace /opt/cyberdeck && chown worker:worker /home/worker /workspace
COPY report.mjs launch.mjs /opt/cyberdeck/
ENV HOME=/home/worker PNPM_HOME=/home/worker/.local/share/pnpm
USER worker
WORKDIR /workspace
CMD ["sleep", "infinity"]
