# Build explicitly in the serialized proof lane, then configure the resulting immutable image ID.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.5.0
WORKDIR /opt/evaluator
COPY evals/package.json evals/pnpm-lock.yaml evals/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
WORKDIR /opt/evaluator
COPY --from=dependencies /opt/evaluator/node_modules ./node_modules
COPY evals/production/container-entrypoint.mjs evals/production/echo-provider.cjs ./production/
USER 1000:1000
ENV HOME=/tmp/home PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1
ENTRYPOINT ["node", "/opt/evaluator/production/container-entrypoint.mjs"]
