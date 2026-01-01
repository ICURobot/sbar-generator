#!/bin/bash

# Kill any existing processes on these ports
lsof -ti:8000 | xargs kill -9 2>/dev/null

# Start FastAPI Backend Server
echo "🚀 Starting ICU SBAR Generator..."
cd "$(dirname "$0")"
source venv312/bin/activate
python main.py > /tmp/backend.log 2>&1 &
BACKEND_PID=$!

# Wait a moment for backend to start
sleep 3

# Check if backend started successfully
if ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo "❌ Server failed to start. Check /tmp/backend.log"
    cat /tmp/backend.log
    exit 1
fi

echo ""
echo "✅ Application started successfully!"
echo "👉 Open your browser to: http://localhost:8000"
echo ""
echo "Server PID: $BACKEND_PID"
echo "Logs: tail -f /tmp/backend.log"
echo ""
echo "Press Ctrl+C to stop the server"

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping server..."
    kill $BACKEND_PID 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for user interrupt
wait

