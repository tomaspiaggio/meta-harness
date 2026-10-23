# Pin NODE_IMAGE to a reviewed digest for a deployed release.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.10.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# No Docker socket, personal home, database or control-plane .env is mounted.
# The root supervisor drops each native child to a separate unprivileged UID.
ENV HARNESS_ISOLATE_AGENTS=1 HARNESS_BROWSER_ENABLED=0 HARNESS_CONCURRENCY=1 HARNESS_WORKER_DATA_DIR=/work HARNESS_WORKER_TOKEN_FILE=/run/harness/worker.json
WORKDIR /app/apps/worker
CMD ["node", "--import", "tsx", "src/index.ts"]
