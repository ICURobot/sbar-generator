# ICU SBAR Generator - Full-Stack AI Application

A full-stack AI application for generating ICU SBAR (Situation, Background, Assessment, Recommendation) reports using Google Vertex AI (Gemini 2.0) and Turso Vector Database.

## Features

- **AI-Powered SBAR Generation**: Generate professional SBAR handoff reports using patient data and ICU textbook knowledge
- **Knowledge Base Chat**: Ask questions about ICU protocols, medications, and patient care
- **Vector Search**: Semantic search through ICU textbook content using embeddings
- **Voice Input**: Speech-to-text for quick form filling (existing feature)

## Tech Stack

- **Backend**: FastAPI (Python)
- **AI**: Google Vertex AI (Gemini 2.0 Flash)
- **Vector DB**: Turso (libSQL)
- **Embeddings**: Sentence Transformers (all-MiniLM-L6-v2)
- **Frontend**: HTML, JavaScript, Tailwind CSS

## Setup Instructions

### 1. Install Python Dependencies

```bash
pip install -r requirements.txt
```

### 2. Set Up Environment Variables

Create a `.env` file in the project root:

```bash
# Google Cloud Credentials
GOOGLE_APPLICATION_CREDENTIALS=google_credentials.json
GOOGLE_CLOUD_PROJECT_ID=your-project-id
GOOGLE_CLOUD_LOCATION=us-central1

# Turso Database
TURSO_DATABASE_URL=libsql://your-database-url.turso.io
TURSO_AUTH_TOKEN=your-auth-token
```

### 3. Google Cloud Setup

1. Create a Google Cloud project and enable Vertex AI API
2. Create a service account and download the credentials JSON file
3. Place the file as `google_credentials.json` in the project root
4. Set `GOOGLE_CLOUD_PROJECT_ID` to your project ID

### 4. Turso Database Setup

1. Create a Turso account at https://turso.tech
2. Create a new database
3. Get your database URL and auth token
4. Set the environment variables accordingly

### 5. Ingest the ICU Book

Place your `icu_book.pdf` file in the project root, then run:

```bash
python ingest_book.py
```

This will:
- Extract text from the PDF
- Chunk the text (300 words per chunk, 50 word overlap)
- Generate embeddings using sentence transformers
- Upload chunks and embeddings to Turso

### 6. Start the FastAPI Server

```bash
python main.py
```

Or using uvicorn directly:

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The API will be available at `http://localhost:8000`

### 7. Open the Frontend

Open `index.html` in your browser or serve it with a local server:

```bash
# Using Python
python -m http.server 8080

# Or using Node.js
npx serve .
```

## API Endpoints

### POST `/chat`

Chat with the knowledge base about ICU care.

**Request:**
```json
{
  "question": "What is the dose for Levo?"
}
```

**Response:**
```json
{
  "answer": "...",
  "sources": [...]
}
```

### POST `/generate_sbar`

Generate an SBAR report from patient data.

**Request:**
```json
{
  "patientData": {
    "room": "101",
    "name": "John Doe",
    "diagnosis": "Sepsis",
    ...
  }
}
```

**Response:**
```json
{
  "report": {
    "situation": "...",
    "background": "...",
    "assessment": "...",
    "recommendation": "...",
    "ai_suggestion": "..."
  }
}
```

## Project Structure

```
sbar-generator/
├── main.py                 # FastAPI backend
├── ingest_book.py          # PDF ingestion script
├── requirements.txt        # Python dependencies
├── index.html             # Frontend UI
├── script.js              # Frontend JavaScript
├── icu_book.pdf          # ICU textbook (add this file)
├── google_credentials.json # Google Cloud credentials (add this file)
└── .env                   # Environment variables (create this file)
```

## Notes

- The frontend expects the FastAPI server to be running on `http://localhost:8000`
- For production, update CORS settings in `main.py` to restrict origins
- The vector search implementation loads all chunks into memory for similarity calculation. For larger databases, consider implementing approximate nearest neighbor search or using a dedicated vector database.

## Troubleshooting

1. **"Google credentials file not found"**: Make sure `google_credentials.json` exists in the project root
2. **"Turso connection error"**: Verify your `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are correct
3. **"Model not found"**: The sentence transformer model will download automatically on first use
4. **CORS errors**: Make sure the FastAPI server is running and CORS is configured correctly

