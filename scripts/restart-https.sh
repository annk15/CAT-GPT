#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3456}"

stop_port() {
  local pids
  pids=$(fuser "${PORT}/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true)
  if [ -z "$pids" ]; then
    echo "Port ${PORT} is free."
    return
  fi

  echo "Stopping process on port ${PORT}..."
  fuser -k "${PORT}/tcp" 2>/dev/null || true

  for _ in 1 2 3 4 5; do
    if ! fuser "${PORT}/tcp" >/dev/null 2>&1; then
      echo "Port ${PORT} is free."
      return
    fi
    sleep 0.2
  done

  echo "Force-stopping remaining process on port ${PORT}..."
  fuser -k -9 "${PORT}/tcp" 2>/dev/null || true
  sleep 0.2
}

cd "$ROOT"
stop_port
echo "Starting CAT-GPT (HTTPS)..."
exec env USE_HTTPS=1 node server.js
