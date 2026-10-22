#!/bin/sh
# Container entrypoint: refuse to start half-configured, seed the directory file on first run.
set -eu

if [ -z "${PAL_V2_MASTER_KEY:-}" ]; then
  echo "pal-entrypoint: PAL_V2_MASTER_KEY is empty - set it in .env (generate once with: openssl rand -hex 32, and keep it)" >&2
  exit 78
fi
if [ -z "${PAL_V2_SELF_HOST:-}" ]; then
  echo "pal-entrypoint: PAL_V2_SELF_HOST is empty - set HOST_IP in .env (or run docker/init-env.sh)" >&2
  exit 78
fi

# The server-select directory advertises the IP the console connects to. Seed it from the
# example with this host's address; an existing file (the operator's edits) is never touched.
directory_file="${PAL_V2_DIRECTORY_FILE:-/config/directory.json}"
if [ ! -f "$directory_file" ]; then
  mkdir -p "$(dirname "$directory_file")"
  sed "s/192\.0\.2\.121/${PAL_V2_SELF_HOST}/g" \
    /opt/pal-server-v2/server-v2/config/directory.example.json > "$directory_file"
  echo "pal-entrypoint: wrote $directory_file pointing at ${PAL_V2_SELF_HOST}"
fi

exec "$@"
