#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3456}"

if fuser "${PORT}/tcp" >/dev/null 2>&1; then
  echo "Stopping CAT-GPT on port ${PORT}..."
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  sleep 0.3
  if fuser "${PORT}/tcp" >/dev/null 2>&1; then
    fuser -k -9 "${PORT}/tcp" 2>/dev/null || true
  fi
  echo "Stopped."
else
  echo "Nothing running on port ${PORT}."
fi
