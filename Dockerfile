# A standalone Bot server: the console and the agent in one image.
#
# The console (Next.js) builds into the image. The agent builds when the
# container starts, because a few of its choices (which web search, which
# model endpoint) are made from the environment the server runs with, and
# that environment is not in the image. It takes about ten seconds.
#
# The team's computer is a sibling container on the host's Docker daemon, so
# the image carries the Docker CLI and expects /var/run/docker.sock mounted.
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx next build

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=build /app ./
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    BOT_COMPUTER=local \
    BOT_STORE=fs \
    BOT_DATA_DIR=/app/.data \
    BOT_BUILD_ON_START=1
VOLUME ["/app/.data", "/app/.eve/.workflow-data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/eve/v1/health || exit 1
CMD ["node", "scripts/start.mjs"]
