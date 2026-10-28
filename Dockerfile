# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS build

WORKDIR /src

# The local SDK and patched dependency must be present before installation.
COPY package.json ./
COPY packages/errata-plugin-sdk ./packages/errata-plugin-sdk
COPY patches ./patches
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun install

COPY . .

# Cross-compile from the native build stage so arm64 builds do not emulate Vite.
ARG TARGETPLATFORM
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    case "${TARGETPLATFORM}" in \
      linux/amd64) target=bun-linux-x64 ;; \
      linux/arm64) target=bun-linux-arm64 ;; \
      *) echo "Unsupported target platform: ${TARGETPLATFORM}" >&2; exit 1 ;; \
    esac && \
    bun scripts/build-binary.mjs --target="${target}"

FROM debian:bookworm-slim AS runtime

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    export DEBIAN_FRONTEND=noninteractive && \
    apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    groupadd --gid 10001 errata && \
    useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin errata && \
    mkdir -p /data /plugins && \
    chown -R 10001:10001 /data /plugins

WORKDIR /app

LABEL org.opencontainers.image.title="Errata" \
      org.opencontainers.image.description="LLM-assisted writing workspace" \
      org.opencontainers.image.source="https://github.com/lonelyevil/errata" \
      org.opencontainers.image.licenses="GPL-2.0"

ENV DATA_DIR=/data \
    PLUGIN_DIR=/plugins \
    HOST=0.0.0.0 \
    NITRO_HOST=0.0.0.0 \
    PORT=7739 \
    NITRO_PORT=7739

# Keep public/ beside the executable; binary-entry.mjs resolves assets relatively.
COPY --from=build --link --chown=10001:10001 /src/dist/errata /app/errata
COPY --from=build --link --chown=10001:10001 /src/dist/public /app/public

USER 10001:10001

VOLUME ["/data"]
EXPOSE 7739 3000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["curl", "--fail", "--silent", "--show-error", "--max-time", "4", "http://127.0.0.1:7739/api/health"]

ENTRYPOINT ["/app/errata"]
