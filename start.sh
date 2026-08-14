#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

BACKEND_PORT=3010
FRONTEND_PORT=3009

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# `echo -e` / `echo -n` are bash-isms: under `sh start.sh` they print the flag
# literally instead of interpreting it. printf '%b' is portable across sh/bash/zsh.
say() { printf '%b\n' "$*"; }
say_n() { printf '%b' "$*"; }

cleanup() {
    echo ""
    say "${CYAN}Shutting down...${NC}"
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    wait $BACKEND_PID 2>/dev/null || true
    wait $FRONTEND_PID 2>/dev/null || true
    say "${GREEN}All services stopped.${NC}"
    exit 0
}

trap cleanup INT TERM

port_pid() {
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1
}

# Abort early on a busy port. Without this the failure surfaces ~20s later as a
# vite "Port 3009 is already in use" stack trace, with the backend left running.
STALE_PIDS=""
for entry in "$FRONTEND_PORT frontend" "$BACKEND_PORT backend"; do
    port=${entry%% *}
    label=${entry##* }
    pid=$(port_pid "$port" || true)
    if [ -n "$pid" ]; then
        say "${RED}Port $port ($label) is already in use by PID $pid:${NC}"
        say "  $(ps -o command= -p "$pid" 2>/dev/null)"
        STALE_PIDS="$STALE_PIDS $pid"
    fi
done

if [ -n "$STALE_PIDS" ]; then
    echo ""
    say "${CYAN}The app is probably already running: http://localhost:$FRONTEND_PORT${NC}"
    say "${CYAN}To restart it, stop the old processes first:${NC}"
    say "  kill$STALE_PIDS"
    exit 1
fi

# Check dependencies
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
    say "${CYAN}Installing backend dependencies...${NC}"
    cd "$BACKEND_DIR" && npm install
fi

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    say "${CYAN}Installing frontend dependencies...${NC}"
    cd "$FRONTEND_DIR" && npm install
fi

# Rebuild the native module BEFORE backgrounding anything. This takes ~20s and
# used to run inside the backend's background chain, so `node server.js` only
# started ~25s after the banner claimed the backend was up.
say "${CYAN}Rebuilding better-sqlite3 (takes ~20s)...${NC}"
cd "$BACKEND_DIR"
# Realign better-sqlite3's native addon with the current Node ABI. This used to
# pass --build-from-source, which made prebuild-install skip its prebuilt binary
# and hand off to node-gyp: a 22s compile on every single start. Node 24 (ABI
# 137) has a working prebuilt, so plain `npm rebuild` takes ~1s and still
# recovers from a Node version change. It also drops npm's deprecation warning
# about the unknown --build-from-source config.
npm rebuild better-sqlite3

say "${GREEN}Starting backend on port $BACKEND_PORT...${NC}"
node server.js &
BACKEND_PID=$!

# Wait until the backend actually accepts connections. A fixed `sleep 2` let
# vite boot first and hammer /api with ECONNREFUSED.
say_n "Waiting for backend to accept connections"
i=0
while [ "$i" -lt 60 ]; do
    if curl -s -o /dev/null "http://localhost:$BACKEND_PORT/api/config"; then
        say " ${GREEN}ready${NC}"
        break
    fi
    if ! kill -0 $BACKEND_PID 2>/dev/null; then
        echo ""
        say "${RED}Backend exited during startup. See the error above.${NC}"
        exit 1
    fi
    say_n "."
    sleep 1
    i=$((i + 1))
    if [ "$i" -eq 60 ]; then
        echo ""
        say "${RED}Backend did not come up within 60s.${NC}"
        exit 1
    fi
done

say "${GREEN}Starting frontend on port $FRONTEND_PORT...${NC}"
cd "$FRONTEND_DIR"
npx vite --host &
FRONTEND_PID=$!

echo ""
say "${CYAN}========================================${NC}"
say "${GREEN}  Backend:  http://localhost:$BACKEND_PORT${NC}"
say "${GREEN}  Frontend: http://localhost:$FRONTEND_PORT${NC}"
say "${CYAN}========================================${NC}"
say "Press ${RED}Ctrl+C${NC} to stop all services."
echo ""

# Wait for both processes
wait
