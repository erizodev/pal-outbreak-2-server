# PAL Outbreak File #2 server V2, packaged for the Raspberry Pi (arm64/armv7) or any Docker host.
# Build context is the repo root (see compose.yaml); .dockerignore keeps it to server-v2/ + docker/.

# --- Stage 1: the PAL DNAS assets from DNASrep --------------------------------------------
# Only the two trees the PAL server needs are checked out (sparse), pinned to a known commit:
#   www/dnas/eu-gw/packets -> /dnas/packets
#   etc/dnas               -> /dnas/certs
FROM alpine:3.20 AS dnas
ARG DNASREP_URL=https://github.com/FogNo23/DNASrep.git
ARG DNASREP_REF=8e8dad3cae5b340ee1b15157d2db8181f18526e0
RUN apk add --no-cache git \
 && git clone --filter=blob:none --no-checkout "$DNASREP_URL" /src \
 && git -C /src sparse-checkout set --no-cone /www/dnas/eu-gw/packets/ /etc/dnas/ \
 && git -C /src checkout --quiet "$DNASREP_REF" \
 && mkdir -p /dnas/packets /dnas/certs \
 && cp -a /src/www/dnas/eu-gw/packets/. /dnas/packets/ \
 && cp -a /src/etc/dnas/. /dnas/certs/ \
 && test -n "$(ls -A /dnas/packets)" && test -f /dnas/certs/cert-eu.pem

# --- Stage 2: the server --------------------------------------------------------------------
# Node >= 22.13 runs node:sqlite unflagged; the 22 line is past that.
FROM node:22-bookworm-slim
WORKDIR /opt/pal-server-v2
COPY server-v2/ ./server-v2/
COPY --from=dnas /dnas /dnas
COPY docker/entrypoint.sh /usr/local/bin/pal-entrypoint
RUN chmod 0755 /usr/local/bin/pal-entrypoint && mkdir -p /data /config
VOLUME ["/data"]
ENTRYPOINT ["pal-entrypoint"]
CMD ["node", "server-v2/bin/pal-server-v2.js"]
