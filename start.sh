#!/bin/bash

# Kill any existing processes on these ports
lsof -ti:8000,8080 | xargs kill -9 2>/dev/null

# Start FastAPI Backend Server
echo "🚀 Starting FastAPI backend server..."
cd "$(dirname "$0")"
source venv312/bin/activate
python main.py > /tmp/backend.log 2>&1 &
BACKEND_PID=$!

# Wait a moment for backend to start
sleep 5

# Check if backend started successfully
if ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo "❌ Backend failed to start. Check /tmp/backend.log"
    cat /tmp/backend.log
    exit 1
fi

# Start Frontend HTTP Server
echo "🌐 Starting frontend server..."
python3 -m http.server 8080 > /tmp/frontend.log 2>&1 &
FRONTEND_PID=$!

sleep 2

echo ""
echo "✅ Servers started!"
echo "📡 Backend API: http://localhost:8000"
echo "🌐 Frontend: http://localhost:8080"
echo ""
echo "Backend PID: $BACKEND_PID"
echo "Frontend PID: $FRONTEND_PID"
echo ""
echo "Logs:"
echo "  Backend: tail -f /tmp/backend.log"
echo "  Frontend: tail -f /tmp/frontend.log"
echo ""
echo "Press Ctrl+C to stop both servers"

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping servers..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for user interrupt
wait

