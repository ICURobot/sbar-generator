"""
FastAPI Backend for ICU SBAR Generator
Uses Google Vertex AI (Gemini 2.0) and Turso Vector DB
"""
import os
from pathlib import Path
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel
import base64
from google.cloud import aiplatform
from google.oauth2 import service_account
import vertexai
from vertexai.preview.generative_models import GenerativeModel, Part
import numpy as np
import requests
from libsql_experimental import connect
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="ICU SBAR Generator API")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify your frontend domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Google AI Studio API configuration for embeddings
GOOGLE_AI_STUDIO_API_KEY = os.getenv("GOOGLE_AI_STUDIO_API_KEY")
EMBEDDING_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent"

if not GOOGLE_AI_STUDIO_API_KEY or GOOGLE_AI_STUDIO_API_KEY == "your-api-key-here":
    print("⚠️  Warning: GOOGLE_AI_STUDIO_API_KEY not set - vector search will be disabled")
else:
    print("✅ Google AI Studio API configured for embeddings")

# Initialize Vertex AI (with graceful handling for missing credentials)
# Supports both file path (local) and JSON string (Vercel/production)
GOOGLE_APPLICATION_CREDENTIALS = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "google_credentials.json")
LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")
PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT_ID")

# Initialize Vertex AI only if credentials are available
model = None
credentials = None
creds_data = None

# Try to load credentials from environment variable (JSON string) - for Vercel
if GOOGLE_APPLICATION_CREDENTIALS and GOOGLE_APPLICATION_CREDENTIALS != "google_credentials.json":
    try:
        import json
        # Check if it's a JSON string (starts with {)
        if GOOGLE_APPLICATION_CREDENTIALS.strip().startswith('{'):
            creds_data = json.loads(GOOGLE_APPLICATION_CREDENTIALS)
            credentials = service_account.Credentials.from_service_account_info(creds_data)
            print("✅ Loaded Google credentials from environment variable")
        # Otherwise, treat it as a file path
        elif os.path.exists(GOOGLE_APPLICATION_CREDENTIALS):
            with open(GOOGLE_APPLICATION_CREDENTIALS, 'r') as f:
                creds_data = json.load(f)
            credentials = service_account.Credentials.from_service_account_file(GOOGLE_APPLICATION_CREDENTIALS)
            print("✅ Loaded Google credentials from file")
    except json.JSONDecodeError:
        # Not JSON, try as file path
        if os.path.exists(GOOGLE_APPLICATION_CREDENTIALS):
            try:
                with open(GOOGLE_APPLICATION_CREDENTIALS, 'r') as f:
                    creds_data = json.load(f)
                credentials = service_account.Credentials.from_service_account_file(GOOGLE_APPLICATION_CREDENTIALS)
                print("✅ Loaded Google credentials from file")
            except Exception as e:
                print(f"⚠️  Could not load credentials from file: {e}")
        else:
            print(f"⚠️  Credentials path does not exist: {GOOGLE_APPLICATION_CREDENTIALS}")
    except Exception as e:
        print(f"⚠️  Error parsing credentials: {e}")

# Try default file path if credentials not loaded yet
if credentials is None and os.path.exists("google_credentials.json"):
    try:
        import json
        with open("google_credentials.json", 'r') as f:
            creds_data = json.load(f)
        credentials = service_account.Credentials.from_service_account_file("google_credentials.json")
        print("✅ Loaded Google credentials from default file")
    except Exception as e:
        print(f"⚠️  Could not load default credentials file: {e}")

# Initialize Vertex AI if we have credentials
if credentials and creds_data:
    try:
        PROJECT_ID = PROJECT_ID or creds_data.get('project_id')
        if not PROJECT_ID:
            raise ValueError("project_id not found in credentials and GOOGLE_CLOUD_PROJECT_ID not set")
        
        vertexai.init(project=PROJECT_ID, location=LOCATION, credentials=credentials)
        model = GenerativeModel("gemini-2.0-flash-exp")
        print(f"✅ Vertex AI initialized (Project: {PROJECT_ID})")
    except Exception as e:
        print(f"⚠️  Warning: Could not initialize Vertex AI: {e}")
        print("   API endpoints will return errors until credentials are configured")
else:
    print("⚠️  Warning: Google credentials not found")
    print("   Set GOOGLE_APPLICATION_CREDENTIALS as JSON string (Vercel) or file path (local)")
    print("   API endpoints will return errors until credentials are configured")

# Turso connection (optional for now)
TURSO_DATABASE_URL = os.getenv("TURSO_DATABASE_URL")
TURSO_AUTH_TOKEN = os.getenv("TURSO_AUTH_TOKEN")

def get_turso_client():
    """Get a Turso database client."""
    return connect(TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN)

def cosine_similarity(vec1: np.ndarray, vec2: np.ndarray) -> float:
    """Calculate cosine similarity between two vectors."""
    dot_product = np.dot(vec1, vec2)
    norm1 = np.linalg.norm(vec1)
    norm2 = np.linalg.norm(vec2)
    if norm1 == 0 or norm2 == 0:
        return 0.0
    return dot_product / (norm1 * norm2)

def get_embedding(text: str) -> np.ndarray:
    """Get embedding using Google AI Studio API (text-embedding-004)."""
    if not GOOGLE_AI_STUDIO_API_KEY or GOOGLE_AI_STUDIO_API_KEY == "your-api-key-here":
        raise ValueError("GOOGLE_AI_STUDIO_API_KEY not configured")
    
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

def search_turso_knowledge(query: str, top_k: int = 5, book_title_filter: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Search Turso database for relevant knowledge chunks.
    Returns list of chunks with their text and metadata.
    Uses Google AI Studio API for embeddings (matches embeddings stored in Turso).
    
    Args:
        query: Search query text
        top_k: Number of top results to return
        book_title_filter: Optional book title to filter results (e.g., "Lehne's Pharmacology for Nursing Care ( PDFDrive.com )")
    """
    if not TURSO_DATABASE_URL or not TURSO_AUTH_TOKEN:
        return []  # Return empty if Turso not configured
    if not GOOGLE_AI_STUDIO_API_KEY or GOOGLE_AI_STUDIO_API_KEY == "your-api-key-here":
        return []  # Return empty if API key not configured
    
    client = get_turso_client()

    # Generate query embedding using Google AI Studio API (matches stored embeddings)
    try:
        query_embedding = get_embedding(query)
    except Exception as e:
        print(f"⚠️  Error generating embedding: {e}")
        return []  # Return empty if embedding generation fails
    
    # Get chunks from database, optionally filtered by book title
    cursor = client.cursor()
    if book_title_filter:
        cursor.execute("SELECT id, chunk_text, embedding, page_number, book_title FROM medical_knowledge WHERE book_title = ?", (book_title_filter,))
    else:
        cursor.execute("SELECT id, chunk_text, embedding, page_number, book_title FROM medical_knowledge")
    rows = cursor.fetchall()
    
    if not rows:
        return []
    
    # Calculate similarities
    similarities = []
    for row in rows:
        chunk_id, chunk_text, embedding_bytes, page_number, book_title = row[:5]  # Handle variable row length
        stored_embedding = np.frombuffer(embedding_bytes, dtype=np.float32)
        
        similarity = cosine_similarity(query_embedding, stored_embedding)
        similarities.append({
            'id': chunk_id,
            'text': chunk_text,
            'page_number': page_number,
            'book_title': book_title,
            'similarity': float(similarity)  # Convert numpy float to Python float for JSON serialization
        })
    
    # Sort by similarity and return top_k
    similarities.sort(key=lambda x: x['similarity'], reverse=True)
    return similarities[:top_k]

# Request/Response models
class ChatRequest(BaseModel):
    question: str

class ChatResponse(BaseModel):
    answer: str
    sources: List[Dict[str, Any]]

class GenerateSBARRequest(BaseModel):
    patientData: Dict[str, Any]

class GenerateSBARResponse(BaseModel):
    report: Dict[str, str]

# Get the directory where this script is located
BASE_DIR = Path(__file__).resolve().parent

@app.get("/", response_class=HTMLResponse)
def root():
    """Serve the frontend HTML."""
    html_path = BASE_DIR / "api" / "index.html"
    if not html_path.exists():
        # Try alternative path (when running from api folder)
        html_path = BASE_DIR / "index.html"
    if html_path.exists():
        return html_path.read_text()
    return {"message": "ICU SBAR Generator API", "status": "running"}

@app.get("/script.js")
def serve_script():
    """Serve the frontend JavaScript."""
    js_path = BASE_DIR / "api" / "script.js"
    if not js_path.exists():
        js_path = BASE_DIR / "script.js"
    if js_path.exists():
        return FileResponse(js_path, media_type="application/javascript")
    raise HTTPException(status_code=404, detail="Script not found")

@app.get("/health")
def health():
    return {"message": "ICU SBAR Generator API", "status": "running"}

@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    Chat endpoint: Answer questions using knowledge from the ICU book.
    """
    if model is None:
        raise HTTPException(status_code=503, detail="Vertex AI not configured. Please set up Google Cloud credentials.")
    try:
        # Check for specific book requests in the query
        book_filter = None
        query_lower = request.question.lower()
        
        if "critical care nursing" in query_lower or "urden" in query_lower or "icu nursing book" in query_lower:
            book_filter = "Critical Care Nursing, Diagnosis and Management - Urden, Linda D"
        elif "acls" in query_lower:
            book_filter = "Advanced Cardiac Life Support Provider Handbook 2015-2020 ( PDFDrive )"
        elif "lehne" in query_lower or "pharmacology" in query_lower:
            book_filter = "Lehne’s Pharmacology for Nursing Care ( PDFDrive.com )"
        elif "tncc" in query_lower or "trauma" in query_lower:
            book_filter = "TNCC 8th Edition"
        elif "marino" in query_lower or "icu physician" in query_lower:
            book_filter = "MarinoICUphysician"
        elif "canadian" in query_lower or "lab" in query_lower:
            book_filter = "Canadian Lab Test Manual"

        # Search for relevant knowledge
        # Increase top_k to 15 to ensure we get a broader context
        relevant_chunks = search_turso_knowledge(request.question, top_k=15, book_title_filter=book_filter)
        
        # Build context from relevant chunks
        context_parts = []
        for i, chunk in enumerate(relevant_chunks, 1):
            page_info = f" (Page {chunk['page_number']})" if chunk['page_number'] else ""
            book_info = f" [Book: {chunk.get('book_title', 'Unknown')}]"
            context_parts.append(f"[Source {i}{book_info}{page_info}]\n{chunk['text']}\n")
        
        context = "\n---\n".join(context_parts)
        
        # Build prompt for Gemini
        prompt = f"""You are an AI assistant helping ICU nurses with questions about critical care medicine.
        
Use the following knowledge from authoritative ICU textbooks to answer the question.

KNOWLEDGE BASE:
{context}

QUESTION: {request.question}

INSTRUCTIONS:
1. Provide a clear, concise, and clinically accurate answer based on the KNOWLEDGE BASE.
2. If the text contains specific values, Normal Ranges, or drug dosages, PROVIDE THEM EXPLICITLY.
3. If the sources contain disclaimers about "checking local labs" or "variability", you should mention the disclaimer BUT STILL PROVIDE the values found in the text (e.g., "The text lists the range as X-Y, noting that local labs may vary").
4. Do NOT refuse to answer because of a general disclaimer if the data is present in the chunks.
5. If the knowledge doesn't contain the answer at all, say so clearly.

Cite which source(s) and book(s) you used.
"""
        
        # Generate response using Gemini 2.0
        response = model.generate_content(prompt)
        answer = response.text
        
        # Prepare sources for response
        sources = [
            {
                "text": chunk['text'][:200] + "..." if len(chunk['text']) > 200 else chunk['text'],
                "page_number": chunk['page_number'],
                "book_title": chunk.get('book_title', 'Unknown'),
                "similarity": round(float(chunk['similarity']), 3)  # Ensure it's a Python float
            }
            for chunk in relevant_chunks
        ]
        
        return ChatResponse(answer=answer, sources=sources)
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error generating chat response: {str(e)}")

@app.post("/generate_sbar", response_model=GenerateSBARResponse)
async def generate_sbar(request: GenerateSBARRequest):
    """
    Generate SBAR report endpoint: Creates professional SBAR handoff note.
    """
    if model is None:
        raise HTTPException(status_code=503, detail="Vertex AI not configured. Please set up Google Cloud credentials.")
    try:
        patient_data = request.patientData
        
        # Extract key patient information for multiple targeted searches
        diagnosis = patient_data.get("diagnosis", "").strip()
        vent_settings = patient_data.get("vent-settings", "")
        drips = patient_data.get("drips", "")
        medications = patient_data.get("medications", "")
        
        # Book Titles
        lehne_book = "Lehne’s Pharmacology for Nursing Care ( PDFDrive.com )"
        canadian_book = "Canadian Lab Test Manual"
        marino_book = "MarinoICUphysician"
        urden_book = "Critical Care Nursing, Diagnosis and Management - Urden, Linda D"
        
        # Repositories for chunks
        lab_chunks = []
        pharm_chunks = []
        general_chunks = []
        seen_ids = set()
        
        # --- 1. LABS & DIAGNOSTICS SEARCH ---
        # Primary: Canadian Lab Test Manual
        lab_query = f"{diagnosis} lab tests monitoring diagnostics" if diagnosis else "ICU lab tests diagnostics monitoring"
        chunks = search_turso_knowledge(lab_query, top_k=10, book_title_filter=canadian_book)
        for c in chunks:
            if c['id'] not in seen_ids:
                lab_chunks.append(c)
                seen_ids.add(c['id'])
                
        # Secondary: Marino & Urden
        for book in [marino_book, urden_book]:
            chunks = search_turso_knowledge(lab_query, top_k=5, book_title_filter=book)
            for c in chunks:
                if c['id'] not in seen_ids:
                    lab_chunks.append(c)
                    seen_ids.add(c['id'])

        # --- 2. PHARMACOLOGY & DRIPS SEARCH ---
        # Combine meds/drips text
        all_meds_text = f"{medications} {drips}".strip()
        med_query_base = f"{diagnosis} pharmacology medication management" if diagnosis else "ICU pharmacology medication management"
        
        # Primary: Lehne's
        chunks = search_turso_knowledge(med_query_base, top_k=10, book_title_filter=lehne_book)
        for c in chunks:
            if c['id'] not in seen_ids:
                pharm_chunks.append(c)
                seen_ids.add(c['id'])
        
        # Search specifically for mentioned meds in Lehne's
        if all_meds_text:
            med_specific_query = f"{all_meds_text} dosing interactions monitoring"
            chunks = search_turso_knowledge(med_specific_query, top_k=8, book_title_filter=lehne_book)
            for c in chunks:
                if c['id'] not in seen_ids:
                    pharm_chunks.append(c)
                    seen_ids.add(c['id'])
                    
        # Secondary: Marino & Urden (for clinical context of these meds)
        for book in [marino_book, urden_book]:
            chunks = search_turso_knowledge(med_query_base, top_k=5, book_title_filter=book)
            for c in chunks:
                if c['id'] not in seen_ids:
                    pharm_chunks.append(c)
                    seen_ids.add(c['id'])

        # --- 3. GENERAL CLINICAL CONTEXT (Diagnosis/Vents) ---
        # Search Urden & Marino text for general care
        clinical_query = f"{diagnosis} nursing care management intervention" if diagnosis else "ICU nursing care management"
        for book in [urden_book, marino_book]:
            chunks = search_turso_knowledge(clinical_query, top_k=8, book_title_filter=book)
            for c in chunks:
                if c['id'] not in seen_ids:
                    general_chunks.append(c)
                    seen_ids.add(c['id'])
                    
        # Ventilator search if needed
        if vent_settings:
            vent_query = "ventilator management mechanical ventilation"
            chunks = search_turso_knowledge(vent_query, top_k=5) # Search all books for vent
            for c in chunks:
                if c['id'] not in seen_ids:
                    general_chunks.append(c)
                    seen_ids.add(c['id'])

        # --- BUILD CONTEXT STRINGS ---
        def format_chunks(chunk_list, section_name):
            if not chunk_list:
                return f"No specific {section_name} information found."
            parts = []
            # Sort by similarity
            chunk_list.sort(key=lambda x: x['similarity'], reverse=True)
            for i, c in enumerate(chunk_list[:15], 1): # Top 15 per section
                parts.append(f"[{section_name} Source {i} - {c.get('book_title', 'Unknown')} (Page {c.get('page_number', '?')})]\n{c['text']}")
            return "\n\n".join(parts)

        lab_context = format_chunks(lab_chunks, "LABS_DIAGNOSTICS")
        pharm_context = format_chunks(pharm_chunks, "PHARMACOLOGY")
        general_context = format_chunks(general_chunks, "CLINICAL_GUIDELINES")
        
        # Build comprehensive prompt for Gemini
        prompt = f"""You are a multi-persona AI assistant for ICU nurses. Generate a professional SBAR output.

SOURCES TO USE:
1. LABS & DIAGNOSTICS KNOWLEDGE (Primary: Canadian Lab Manual, Secondary: Marino/Urden):
{lab_context}

2. PHARMACOLOGY KNOWLEDGE (Primary: Lehne's, Secondary: Marino/Urden):
{pharm_context}

3. GENERAL CLINICAL GUIDELINES (Marino/Urden):
{general_context}

PATIENT DATA:
{patient_data}

INSTRUCTIONS:
Generate a JSON object with keys: "situation", "background", "assessment", "recommendation", "ai_suggestion".

1. **"situation"**: Standard SBAR situation.
2. **"background"**: Standard SBAR background.
3. **"assessment"**:
   - **Clinical Assessment (Head-to-Toe)**: Organize key findings by system: **Neurological**, **Cardiovascular**, **Respiratory**, **Gastrointestinal/Genitourinary**, **Skin/Extremities**. Use the 'GENERAL CLINICAL GUIDELINES' source.
   - **Labs & Diagnostics Analysis**: Dedicated subsection. MUST use the 'LABS & DIAGNOSTICS KNOWLEDGE' source. Compare patient values to **Canadian Lab Test Manual** ranges.
   - **Pharmacology & Drips Analysis**: Dedicated subsection. MUST use the 'PHARMACOLOGY KNOWLEDGE' source (Lehne's). Discuss indications, titration, and nursing considerations for active drips/meds.

4. **"recommendation"**: Synthesize all sources. Provide specific, actionable steps.
5. **"ai_suggestion"**: High-level physician perspective.

**ANTI-SHYNESS RULE**: If the texts contain specific values, doses, or ranges, PROVIDE THEM. Do not withhold data due to general disclaimers.

Generate ONLY valid JSON.
"""
        
        # Generate response using Gemini 2.0
        response = model.generate_content(prompt)
        
        # Parse JSON response
        import json
        try:
            report_json = json.loads(response.text)
        except json.JSONDecodeError:
            # If JSON parsing fails, try to extract JSON from markdown
            text = response.text.strip()
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0].strip()
            elif "```" in text:
                text = text.split("```")[1].split("```")[0].strip()
            report_json = json.loads(text)
        
        # Ensure all required keys exist and convert nested structures to strings
        required_keys = ["situation", "background", "assessment", "recommendation", "ai_suggestion"]
        
        def convert_to_string(value):
            """Convert nested dictionaries/lists to formatted string."""
            if isinstance(value, str):
                return value
            elif isinstance(value, dict):
                # Format dictionary as a readable string
                lines = []
                for k, v in value.items():
                    if isinstance(v, list):
                        lines.append(f"{k}:")
                        for item in v:
                            lines.append(f"  • {item}")
                    elif isinstance(v, dict):
                        lines.append(f"{k}:")
                        for sub_k, sub_v in v.items():
                            lines.append(f"  • {sub_k}: {sub_v}")
                    else:
                        lines.append(f"{k}: {v}")
                return "\n".join(lines)
            elif isinstance(value, list):
                return "\n".join([f"• {item}" for item in value])
            else:
                return str(value)
        
        # Convert all values to strings
        final_report = {}
        for key in required_keys:
            if key in report_json:
                final_report[key] = convert_to_string(report_json[key])
            else:
                final_report[key] = ""
        
        return GenerateSBARResponse(report=final_report)
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error generating SBAR report: {str(e)}")

class ProcessReportRequest(BaseModel):
    text: Optional[str] = None
    input_type: str  # "voice", "text", or "image"

@app.post("/process_report")
async def process_report(
    input_type: str = Form(...),
    text: Optional[str] = Form(None),
    image: Optional[UploadFile] = File(None)
):
    """
    Process report from voice transcript, free text, or image.
    Extracts structured patient data using Gemini AI.
    """
    if model is None:
        raise HTTPException(status_code=503, detail="Vertex AI not configured. Please set up Google Cloud credentials.")
    
    try:
        # Form field IDs that need to be extracted
        form_fields = [
            "room", "name", "age-sex", "md", "allergies", "code-status", "isolation",
            "diagnosis", "history", "loc", "pupils", "sedation-pain", "delirium-score",
            "evd", "temperature", "hr-rhythm", "bp-map", "pulses", "pacemaker", "iabp",
            "o2-delivery", "vent-settings", "trach-airway", "breath-sounds", "diet",
            "abdomen", "urine-output", "iv-lines", "art-line", "central-line",
            "drains-tubes", "skin-integrity", "traction-fixators", "fractures-braces",
            "labs-diagnostics", "family-communication", "drips", "medications", "plan"
        ]
        
        prompt_parts = []
        
        if input_type == "image" and image:
            # Process image with Gemini Vision
            image_data = await image.read()
            mime_type = image.content_type or "image/jpeg"
            
            # Create image part for Gemini using Part API
            image_part = Part.from_data(data=image_data, mime_type=mime_type)
            
            prompt_text = f"""You are an expert medical data extraction AI. Analyze this image of a patient report, whiteboard, notes, or medical document.

Extract all patient information and structure it as a JSON object. The JSON object keys MUST correspond to these form field IDs:
{', '.join(form_fields)}

For each field:
- Extract the relevant information if present in the image
- Use medical terminology correctly
- If information is not visible or not present, omit that key from the JSON
- For vital signs, extract numbers and units accurately
- For medications, list them clearly
- For dates/times, preserve the format shown

Return ONLY a valid JSON object with the extracted data. Do not include any explanatory text."""
            
            # Use Gemini with vision
            response = model.generate_content([image_part, prompt_text])
            
        elif input_type in ["voice", "text"] and text:
            # Process text (voice transcript or free text)
            input_label = "voice-to-text transcript" if input_type == "voice" else "free-text report"
            
            prompt_text = f"""You are an expert medical data extraction AI. Your task is to extract structured data from a {input_label} from an ICU nurse.

1. **Internal Cleaning (for voice transcripts):** If this is a voice transcript, mentally correct any spelling, grammar, and medical terminology errors. For example, correct "leave a fed" to "levophed" and "proper fall" to "propofol". Do not show this corrected version in the output.

2. **Data Extraction:** Parse the cleaned/corrected information into a structured JSON object. The JSON object keys MUST correspond to these form field IDs:
{', '.join(form_fields)}

If information for a key is not present in the {input_label}, omit the key from the final JSON object.

Return ONLY the final JSON object, no markdown formatting.

{input_label.capitalize()}:
---
{text}
---"""
            
            response = model.generate_content(prompt_text)
        else:
            raise HTTPException(status_code=400, detail="Invalid input: provide text for voice/text input or image for image input")
        
        # Parse JSON response
        import json
        try:
            result_text = response.text.strip()
            # Clean up if there's markdown formatting
            if "```json" in result_text:
                result_text = result_text.split("```json")[1].split("```")[0].strip()
            elif "```" in result_text:
                result_text = result_text.split("```")[1].split("```")[0].strip()
            
            form_data = json.loads(result_text)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=500, detail=f"Failed to parse AI response as JSON: {str(e)}")
        
        return {"formData": form_data}
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing report: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))  # Use PORT env var for Render, default to 8000 for local
    uvicorn.run(app, host="0.0.0.0", port=port)

