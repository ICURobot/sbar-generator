"""
Knowledge Ingestion Script for ICU Book
Processes PDF using Gemini Vision for text extraction, chunks text, generates embeddings, and uploads to Turso Vector DB
"""
import os
import sys
from pathlib import Path
import fitz  # PyMuPDF
import numpy as np
from libsql_experimental import connect
from dotenv import load_dotenv
import vertexai
from vertexai.preview.generative_models import GenerativeModel, Part
from google.oauth2 import service_account
import json
import time
import requests

load_dotenv()

# Configuration
CHUNK_SIZE = 300  # words per chunk
CHUNK_OVERLAP = 50  # overlapping words
TABLE_NAME = "medical_knowledge"

# Google AI Studio API configuration
GOOGLE_AI_STUDIO_API_KEY = os.getenv("GOOGLE_AI_STUDIO_API_KEY")
if not GOOGLE_AI_STUDIO_API_KEY:
    raise ValueError("GOOGLE_AI_STUDIO_API_KEY not found in environment variables. Please set it in .env file.")

EMBEDDING_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent"

def get_embedding_google_ai_studio(text: str) -> np.ndarray:
    """
    Get embedding using Google AI Studio API (text-embedding-004).
    Returns a numpy array of the embedding vector.
    """
    headers = {
        "Content-Type": "application/json",
    }
    
    payload = {
        "model": "models/text-embedding-004",
        "content": {
            "parts": [{"text": text}]
        }
    }
    
    params = {
        "key": GOOGLE_AI_STUDIO_API_KEY
    }
    
    try:
        response = requests.post(EMBEDDING_API_URL, json=payload, headers=headers, params=params)
        response.raise_for_status()
        
        result = response.json()
        embedding_values = result.get("embedding", {}).get("values", [])
        
        if not embedding_values:
            raise ValueError("No embedding values returned from API")
        
        return np.array(embedding_values, dtype=np.float32)
    except requests.exceptions.RequestException as e:
        raise Exception(f"Error calling Google AI Studio API: {e}")
    except KeyError as e:
        raise Exception(f"Unexpected API response format: {e}")

def get_embeddings_batch_google_ai_studio(texts: list) -> list:
    """
    Get embeddings for a batch of texts using Google AI Studio API.
    Note: The API may have rate limits, so we'll process one at a time with a small delay.
    """
    embeddings = []
    for i, text in enumerate(texts):
        if i > 0 and i % 10 == 0:
            print(f"    Processed {i}/{len(texts)} embeddings...")
            time.sleep(0.1)  # Small delay to avoid rate limits
        embedding = get_embedding_google_ai_studio(text)
        embeddings.append(embedding)
    return embeddings

print("✅ Using Google AI Studio API for embeddings (text-embedding-004)")

# Initialize Vertex AI for Gemini Vision
GOOGLE_APPLICATION_CREDENTIALS = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "google_credentials.json")
LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

# Load project_id from credentials file
if os.path.exists(GOOGLE_APPLICATION_CREDENTIALS):
    with open(GOOGLE_APPLICATION_CREDENTIALS, 'r') as f:
        creds_data = json.load(f)
        PROJECT_ID = creds_data.get('project_id') or os.getenv("GOOGLE_CLOUD_PROJECT_ID")
    
    if PROJECT_ID:
        credentials = service_account.Credentials.from_service_account_file(
            GOOGLE_APPLICATION_CREDENTIALS
        )
        vertexai.init(project=PROJECT_ID, location=LOCATION, credentials=credentials)
        # Use the same model as main.py
        gemini_model = GenerativeModel("gemini-2.0-flash-exp")
        print("✅ Gemini Vision initialized for text extraction")
    else:
        raise ValueError("project_id not found in credentials file")
else:
    raise FileNotFoundError(f"Google credentials file not found: {GOOGLE_APPLICATION_CREDENTIALS}")

def chunk_text(text, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Split text into overlapping chunks by word count."""
    words = text.split()
    chunks = []
    
    i = 0
    while i < len(words):
        chunk_words = words[i:i + chunk_size]
        chunk_text = ' '.join(chunk_words)
        chunks.append({
            'text': chunk_text,
            'start_word': i,
            'end_word': min(i + chunk_size, len(words))
        })
        i += chunk_size - overlap
    
    return chunks

def extract_text_from_pdf_with_gemini(pdf_path, book_title=None):
    """
    Extract text from PDF using Gemini Vision for high-quality OCR.
    Converts each PDF page to an image and sends to Gemini for text extraction.
    
    Args:
        pdf_path: Path to the PDF file
        book_title: Optional title for the book (if None, uses filename)
    """
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF file not found: {pdf_path}")
    
    if book_title is None:
        book_title = Path(pdf_path).stem  # Use filename without extension as title
    
    print(f"📖 Reading PDF: {pdf_path}")
    print(f"   Book Title: {book_title}")
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    print(f"   Found {total_pages} pages")
    
    full_text = ""
    
    for page_num in range(total_pages):
        page = doc[page_num]
        
        # Convert PDF page to image (PNG)
        # Scale factor of 2 for better quality
        mat = fitz.Matrix(2.0, 2.0)  # 2x zoom for better OCR quality
        pix = page.get_pixmap(matrix=mat)
        img_data = pix.tobytes("png")
        
        print(f"   Processing page {page_num + 1}/{total_pages} with Gemini Vision...", end=" ", flush=True)
        
        # Retry logic with exponential backoff for rate limits
        max_retries = 10
        retry_delay = 2  # Start with 2 seconds
        page_text = None
        
        for attempt in range(max_retries):
            try:
                # Create image part for Gemini
                image_part = Part.from_data(data=img_data, mime_type="image/png")
                
                # Prompt for Gemini to extract text
                prompt = """Extract all text from this medical textbook page. 
                
Please:
1. Extract ALL visible text including headers, body text, captions, footnotes, and any text in tables or diagrams
2. Preserve the structure and formatting as much as possible (use line breaks appropriately)
3. Maintain medical terminology exactly as shown
4. Include page numbers if visible
5. For tables, preserve the table structure with clear separators
6. For multi-column layouts, maintain column separation

Return ONLY the extracted text, nothing else. Do not add explanations or summaries."""
                
                # Get response from Gemini
                response = gemini_model.generate_content([image_part, prompt])
                page_text = response.text.strip()
                break  # Success, exit retry loop
                
            except Exception as e:
                error_str = str(e).lower()
                # Check if it's a rate limit error (429 or "resource exhausted")
                is_rate_limit = "429" in error_str or "resource exhausted" in error_str or "quota" in error_str
                
                if is_rate_limit:
                    if attempt < max_retries - 1:
                        # Exponential backoff: 2s, 4s, 8s, 16s, 32s...
                        # If quota exhausted, we might need a longer wait
                        wait_time = retry_delay * (2 ** attempt)
                        if "per_minute" in error_str:
                             wait_time = max(wait_time, 30) # Wait at least 30s if minute quota hit
                        
                        print(f"⏳ Rate limited, waiting {wait_time}s before retry...", end=" ", flush=True)
                        time.sleep(wait_time)
                        continue
                
                print(f"❌ Error: {e}")
                # Only fallback if it's NOT a rate limit or we ran out of retries
                if attempt == max_retries - 1:
                    try:
                        page_text = page.get_text()
                        full_text += f"\n\n--- Page {page_num + 1} (fallback extraction) ---\n\n{page_text}"
                        print(f"   Used fallback extraction ({len(page_text)} characters)")
                    except:
                        print(f"   ⚠️  Skipped page {page_num + 1}")
                    page_text = None
                break
        
        if page_text:
            full_text += f"\n\n--- Page {page_num + 1} ---\n\n{page_text}"
            print(f"✅ ({len(page_text)} characters)")
        
        # Rate limiting: 5 second delay to stay under RPM limits
        time.sleep(5)
    
    doc.close()
    return full_text, book_title

def create_table_if_not_exists(client):
    """Create the medical_knowledge table if it doesn't exist."""
    create_table_sql = f"""
    CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        page_number INTEGER,
        chunk_index INTEGER,
        book_title TEXT,
        source_file TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """
    cursor = client.cursor()
    cursor.execute(create_table_sql)
    client.commit()
    print(f"Table '{TABLE_NAME}' ready.")

def insert_chunk_batch(client, chunks_data):
    """
    Insert a batch of chunks with their embeddings into Turso.
    chunks_data: List of tuples (chunk_text, embedding, page_number, chunk_index, book_title, source_file)
    """
    if not chunks_data:
        return 0
    
    cursor = client.cursor()
    insert_sql = f"""
    INSERT INTO {TABLE_NAME} (chunk_text, embedding, page_number, chunk_index, book_title, source_file)
    VALUES (?, ?, ?, ?, ?, ?)
    """
    
    rows_inserted = 0
    for chunk_text, embedding, page_number, chunk_index, book_title, source_file in chunks_data:
        # Ensure embedding is float32 and convert to bytes
        if isinstance(embedding, np.ndarray):
            embedding_array = embedding.astype(np.float32)
        else:
            embedding_array = np.array(embedding, dtype=np.float32)
        embedding_bytes = embedding_array.tobytes()
        
        # Execute with tuple parameters (not list)
        cursor.execute(insert_sql, (
            chunk_text, 
            embedding_bytes, 
            page_number, 
            chunk_index, 
            book_title, 
            source_file
        ))
        rows_inserted += 1
    
    # Explicitly commit the batch
    client.commit()
    return rows_inserted

def process_pdf(pdf_path, book_title=None, client=None):
    """
    Process a single PDF file: extract text, chunk, generate embeddings, and upload to Turso.
    
    Args:
        pdf_path: Path to the PDF file
        book_title: Optional title for the book (if None, uses filename)
        client: Turso database client (if None, creates a new one)
    """
    if client is None:
        # Get environment variables
        database_url = os.getenv("TURSO_DATABASE_URL")
        auth_token = os.getenv("TURSO_AUTH_TOKEN")
        
        if not database_url or not auth_token:
            raise ValueError(
                "Missing required environment variables: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN"
            )
        
        # Connect to Turso
        print("Connecting to Turso database...")
        client = connect(database_url, auth_token=auth_token)
        create_table_if_not_exists(client)
    
    # Extract text from PDF using Gemini Vision
    print(f"\n{'='*60}")
    print(f"🔍 Processing: {pdf_path}")
    print(f"{'='*60}")
    full_text, final_book_title = extract_text_from_pdf_with_gemini(pdf_path, book_title)
    print(f"\n✅ Extracted {len(full_text)} characters from PDF")
    
    # Split into chunks
    print(f"Chunking text (size: {CHUNK_SIZE} words, overlap: {CHUNK_OVERLAP} words)...")
    chunks = chunk_text(full_text)
    print(f"Created {len(chunks)} chunks")
    
    # Generate embeddings and insert into database
    print("Generating embeddings and uploading to Turso...")
    embedding_batch_size = 50  # Generate embeddings in batches
    insert_batch_size = 50  # Insert in batches of 50 and commit
    
    source_filename = Path(pdf_path).name
    total_inserted = 0
    
    # Process chunks in embedding batches
    for emb_i in range(0, len(chunks), embedding_batch_size):
        emb_batch = chunks[emb_i:emb_i + embedding_batch_size]
        chunk_texts = [chunk['text'] for chunk in emb_batch]
        
        # Generate embeddings for batch using Google AI Studio API
        print(f"Generating embeddings for batch {emb_i//embedding_batch_size + 1}/{(len(chunks) + embedding_batch_size - 1)//embedding_batch_size}...")
        embeddings = get_embeddings_batch_google_ai_studio(chunk_texts)
        
        # Prepare data for batch insertion
        batch_data = []
        for j, (chunk, embedding) in enumerate(zip(emb_batch, embeddings)):
            # Try to extract page number from chunk text
            page_num = None
            if "--- Page" in chunk['text']:
                try:
                    page_line = [line for line in chunk['text'].split('\n') if '--- Page' in line]
                    if page_line:
                        page_num = int(page_line[0].split('Page')[1].split('---')[0].strip())
                except:
                    pass
            
            batch_data.append((
                chunk['text'],
                embedding,
                page_num,
                emb_i + j,
                final_book_title,
                source_filename
            ))
        
        # Insert in batches of 50 and commit after each batch
        for insert_i in range(0, len(batch_data), insert_batch_size):
            insert_batch = batch_data[insert_i:insert_i + insert_batch_size]
            rows_inserted = insert_chunk_batch(client, insert_batch)
            total_inserted += rows_inserted
            print(f"  ✅ Successfully inserted {rows_inserted} rows (Total: {total_inserted}/{len(chunks)})")
    
    print(f"\n✅ Successfully ingested {total_inserted} chunks from '{final_book_title}' into Turso database!")
    return total_inserted

def main():
    # Get environment variables
    database_url = os.getenv("TURSO_DATABASE_URL")
    auth_token = os.getenv("TURSO_AUTH_TOKEN")
    
    if not database_url or not auth_token:
        raise ValueError(
            "Missing required environment variables: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN"
        )
    
    # Connect to Turso
    print("Connecting to Turso database...")
    client = connect(database_url, auth_token=auth_token)
    create_table_if_not_exists(client)
    
    # Get PDF files from command line arguments or process all PDFs in books/ folder
    books_folder = Path('books')
    
    if len(sys.argv) > 1:
        # Process PDFs specified as command-line arguments
        pdf_files = []
        for pdf_arg in sys.argv[1:]:
            pdf_path = Path(pdf_arg)
            # If relative path, check books folder first, then current directory
            if not pdf_path.is_absolute():
                if (books_folder / pdf_path.name).exists():
                    pdf_files.append(books_folder / pdf_path.name)
                elif pdf_path.exists():
                    pdf_files.append(pdf_path)
                else:
                    print(f"⚠️  Warning: {pdf_arg} not found")
            else:
                if pdf_path.exists():
                    pdf_files.append(pdf_path)
                else:
                    print(f"⚠️  Warning: {pdf_arg} not found")
        
        if not pdf_files:
            print("❌ No valid PDF files found!")
            sys.exit(1)
        print(f"\n📚 Processing {len(pdf_files)} PDF file(s)...")
    else:
        # Look for all PDF files in books/ folder first, then current directory
        pdf_files = list(books_folder.glob('*.pdf'))
        if not pdf_files:
            # Fallback to current directory
            pdf_files = list(Path('.').glob('*.pdf'))
        
        if not pdf_files:
            print("❌ No PDF files found!")
            print(f"\n📁 Please place your PDF files in the 'books/' folder, or specify them as arguments.")
            print("\nUsage:")
            print("  python ingest_book.py                    # Process all PDFs in books/ folder")
            print("  python ingest_book.py book1.pdf          # Process a specific PDF (searches books/ folder)")
            print("  python ingest_book.py books/book1.pdf    # Process with full path")
            print("  python ingest_book.py book1.pdf book2.pdf # Process multiple PDFs")
            sys.exit(1)
        print(f"\n📚 Found {len(pdf_files)} PDF file(s)...")
    
    total_chunks = 0
    for pdf_path in pdf_files:
        pdf_path = str(pdf_path)
        if not os.path.exists(pdf_path):
            print(f"⚠️  Skipping {pdf_path} (file not found)")
            continue
        
        try:
            chunks_count = process_pdf(pdf_path, client=client)
            total_chunks += chunks_count
        except Exception as e:
            print(f"❌ Error processing {pdf_path}: {e}")
            continue
    
    print(f"\n{'='*60}")
    print(f"🎉 All done! Total chunks ingested: {total_chunks}")
    print(f"Table: {TABLE_NAME}")
    print(f"{'='*60}")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)

