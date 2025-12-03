#!/bin/bash
# Setup script for local development with vectorization support

echo "🔧 Setting up local development environment..."
echo ""

# Check if virtual environment exists
if [ ! -d "venv312" ]; then
    echo "📦 Creating virtual environment..."
    python3.12 -m venv venv312
fi

# Activate virtual environment
echo "🔌 Activating virtual environment..."
source venv312/bin/activate

# Install base requirements (for Vercel deployment)
echo "📥 Installing base requirements (for API server)..."
pip install -r requirements.txt

# Install local-only requirements (for vectorization)
echo "📥 Installing local-only requirements (for book ingestion/vectorization)..."
pip install -r requirements-local.txt

echo ""
echo "✅ Local development environment ready!"
echo ""
echo "To use:"
echo "  1. Activate venv: source venv312/bin/activate"
echo "  2. Run ingestion: python ingest_book.py"
echo "  3. Start server: python main.py"
echo ""

