#!/bin/sh
# Creates .env from .env.example with HOST_IP set to this machine's LAN IPv4.
# Usage (from the repo root, on the Pi):  sh docker/init-env.sh [ip]
set -eu
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env already exists - not overwriting. Edit HOST_IP in it by hand, or delete it first." >&2
  exit 1
fi

ip="${1:-}"
if [ -z "$ip" ]; then
  # The source address of the default route is the LAN address the console can reach.
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
fi
if [ -z "$ip" ]; then
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
if [ -z "$ip" ]; then
  echo "Could not detect the LAN IP - pass it explicitly: sh docker/init-env.sh 192.168.x.y" >&2
  exit 1
fi

sed "s/^HOST_IP=.*/HOST_IP=${ip}/" .env.example > .env
chmod 600 .env
echo "Wrote .env with HOST_IP=${ip}"
echo "Now set PAL_V2_MASTER_KEY in .env (e.g. openssl rand -hex 32), then: docker compose up -d --build"
