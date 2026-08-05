FROM node:22-bookworm-slim AS node-runtime

FROM rust:1.92-slim-bookworm AS build
COPY --from=node-runtime /usr/local/ /usr/local/
RUN apt-get update -qq \
    && apt-get install -y -qq build-essential cmake protobuf-compiler pkg-config libclang-dev libssl-dev git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY . .
RUN npm run build \
    && npm prune --omit=dev

FROM node-runtime AS runtime
RUN apt-get update -qq \
    && apt-get install -y -qq ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 iblue \
    && useradd --uid 10001 --gid iblue --home-dir /app --shell /usr/sbin/nologin iblue \
    && mkdir -p /app /data \
    && chown -R iblue:iblue /app /data

WORKDIR /app
COPY --from=build --chown=iblue:iblue /build/package.json /build/package-lock.json ./
COPY --from=build --chown=iblue:iblue /build/node_modules ./node_modules
COPY --from=build --chown=iblue:iblue /build/dist-ts/src ./dist-ts/src
COPY --from=build --chown=iblue:iblue /build/pkg/rustpushgo/target/release/iblue-native ./iblue-native

ENV NODE_ENV=production \
    IBLUE_NATIVE_PATH=/app/iblue-native
USER iblue
VOLUME ["/data"]
EXPOSE 1234
ENTRYPOINT ["node", "dist-ts/src/cli.js"]
CMD ["help"]
