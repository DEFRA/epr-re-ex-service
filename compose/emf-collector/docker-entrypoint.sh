#!/bin/sh
set -e

socket_gid=$(stat -c '%g' /var/run/docker.sock)

if ! getent group "$socket_gid" > /dev/null 2>&1; then
  addgroup -g "$socket_gid" docker-socket
fi
addgroup node "$(getent group "$socket_gid" | cut -d: -f1)"

exec su node -c "node index.js"
