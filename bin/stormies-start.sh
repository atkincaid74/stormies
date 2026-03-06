#!/bin/bash
# Ensure the stormies server is running on port 3069.
# Safe to call repeatedly — exits immediately if already running.

PORT=3069

# Quick check: is something already listening on the port?
if command -v lsof >/dev/null 2>&1; then
  if lsof -i :"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    exit 0
  fi
elif command -v nc >/dev/null 2>&1; then
  if nc -z localhost "$PORT" 2>/dev/null; then
    exit 0
  fi
fi

# Resolve the repo root (this script lives in <repo>/bin/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check that the server is built
if [ ! -f "$REPO_DIR/server/dist/index.js" ]; then
  echo "[stormies] Server not built. Run 'npm run setup' in $REPO_DIR first." >&2
  exit 1
fi

# Check that webview is built
if [ ! -d "$REPO_DIR/webview-ui/dist" ]; then
  echo "[stormies] Webview not built. Run 'npm run setup' in $REPO_DIR first." >&2
  exit 1
fi

# Start the server in the background
cd "$REPO_DIR"
nohup node server/dist/index.js > /tmp/stormies.log 2>&1 &
echo "[stormies] Server started (pid $!, log at /tmp/stormies.log)"
