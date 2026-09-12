# One image, one port: the server serves the API, the WebSocket relay and the
# built client off a single listener, so nothing here needs a second process or
# a front-end web server.
#
# Bun is both the package manager and the runtime, so the server ships as
# TypeScript source - there is no compile step for it and no dist/server. Only
# the client is built, by Vite, into dist/client.
#
# Every paid integration is off by default. Gemini (commentary text) and
# ElevenLabs (commentary audio) are each gated on their API key being present,
# and this image bakes in no key and copies in no .env file - so both report
# unconfigured and the client falls back to the committed phrase-bank MP3s,
# which AGENTS.md already makes the primary commentary path. Setting either key
# on the container turns that feature back on. Storage is local disk and has no
# paid tier to reach for.

# --- build ------------------------------------------------------------------
FROM oven/bun:1.3-slim AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Ahead of the source copy on purpose: the hand landmarker is a ~9MB download
# from a Google CDN, and pulling it in its own layer means a source change does
# not re-fetch it. The script skips the download when the file is already there
# and only copies the wasm out of node_modules.
COPY scripts/fetch-mediapipe-assets.mjs ./scripts/
RUN bun scripts/fetch-mediapipe-assets.mjs

COPY . .
RUN bun run build

# --- production dependencies -------------------------------------------------
# A separate stage so the runtime image gets a dependency tree that never had
# vite or typescript in it, rather than a pruned one.
FROM oven/bun:1.3-slim AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- runtime ------------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime
ENV NODE_ENV=production

# Bun as PID 1 does not get the kernel's default signal handling, and the
# server installs a handler for SIGINT only. Without an init, `docker stop` and
# a Kubernetes pod eviction both send a SIGTERM that is simply ignored, so the
# container waits out its kill timeout and loses the file store's pending write.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist/client ./dist/client
# The server runs from source under Bun, and it reaches sideways into shared/
# for the wire protocol, so both directories ship as they are.
COPY server ./server
COPY shared ./shared
COPY package.json ./

# The file store writes relative to the working directory, which the
# unprivileged user does not own. Give it a directory of its own and mount a
# volume there to keep leaderboards across restarts.
RUN mkdir -p /data && chown bun:bun /data
ENV DATA_FILE=/data/runs.json

ENV PORT=8787
EXPOSE 8787
USER bun

# Bun has a global fetch, so this costs nothing to the image; adding curl just
# to probe a health endpoint would.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "server/src/index.ts"]
