#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

cleanup() {
    echo ""
    echo -e "${CYAN}Shutting down...${NC}"
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    wait $BACKEND_PID 2>/dev/null || true
    wait $FRONTEND_PID 2>/dev/null || true
    echo -e "${GREEN}All services stopped.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# Check dependencies
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
    echo -e "${CYAN}Installing backend dependencies...${NC}"
    cd "$BACKEND_DIR" && npm install
fi

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo -e "${CYAN}Installing frontend dependencies...${NC}"
    cd "$FRONTEND_DIR" && npm install
fi

echo -e "${GREEN}Starting backend on port 3010...${NC}"
cd "$BACKEND_DIR" && npm rebuild better-sqlite3 --build-from-source 2>/dev/null && node server.js &
BACKEND_PID=$!

# Wait for backend to be ready
sleep 2

echo -e "${GREEN}Starting frontend on port 3009...${NC}"
cd "$FRONTEND_DIR" && npx vite --host &
FRONTEND_PID=$!

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${GREEN}  Backend:  http://localhost:3010${NC}"
echo -e "${GREEN}  Frontend: http://localhost:3009${NC}"
echo -e "${CYAN}========================================${NC}"
echo -e "Press ${RED}Ctrl+C${NC} to stop all services."
echo ""

# Wait for both processes
wait
