"""
FastAPI Backend for ICU SBAR Generator
Uses Google Vertex AI (Gemini 2.0) and Turso Vector DB
"""
import os
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import base64
from google.cloud import aiplatform
from google.oauth2 import service_account
import vertexai
from vertexai.preview.generative_models import GenerativeModel, Part
from vertexai.language_models import TextEmbeddingModel
import numpy as np
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

# Embedding model will be initialized after Vertex AI
embedding_model = None

# Initialize Vertex AI (with graceful handling for missing credentials)
GOOGLE_APPLICATION_CREDENTIALS = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "google_credentials.json")
LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

# Initialize Vertex AI only if credentials are available
model = None
if os.path.exists(GOOGLE_APPLICATION_CREDENTIALS):
    try:
        # Read project_id from the credentials file automatically
        import json
        with open(GOOGLE_APPLICATION_CREDENTIALS, 'r') as f:
            creds_data = json.load(f)
            PROJECT_ID = creds_data.get('project_id') or os.getenv("GOOGLE_CLOUD_PROJECT_ID")
        
        if not PROJECT_ID:
            raise ValueError("project_id not found in credentials file and GOOGLE_CLOUD_PROJECT_ID not set")
        
        credentials = service_account.Credentials.from_service_account_file(
            GOOGLE_APPLICATION_CREDENTIALS
        )
        vertexai.init(project=PROJECT_ID, location=LOCATION, credentials=credentials)
        model = GenerativeModel("gemini-2.0-flash-exp")
        embedding_model = TextEmbeddingModel.from_pretrained("text-embedding-004")
        print(f"✅ Vertex AI initialized successfully (Project: {PROJECT_ID})")
    except Exception as e:
        print(f"⚠️  Warning: Could not initialize Vertex AI: {e}")
        print("   API endpoints will return errors until credentials are configured")
else:
    print("⚠️  Warning: Google credentials file not found")
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
    """Get embedding using Vertex AI text-embedding model."""
    if embedding_model is None:
        raise ValueError("Embedding model not initialized")
    embeddings = embedding_model.get_embeddings([text])
    return np.array(embeddings[0].values, dtype=np.float32)

def search_turso_knowledge(query: str, top_k: int = 5) -> List[Dict[str, Any]]:
    """
    Search Turso database for relevant knowledge chunks.
    Returns list of chunks with their text and metadata.
    """
    if not TURSO_DATABASE_URL or not TURSO_AUTH_TOKEN:
        return []  # Return empty if Turso not configured
    if embedding_model is None:
        return []  # Return empty if embedding model not initialized
    client = get_turso_client()

    # Generate query embedding using Vertex AI
    query_embedding = get_embedding(query)
    
    # Get all chunks from database
    # Note: Turso doesn't have native vector similarity search, so we'll do it in memory
    # For production, consider using a dedicated vector DB or implementing approximate search
    cursor = client.cursor()
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

@app.get("/")
def root():
    return {"message": "ICU SBAR Generator API", "status": "running"}

@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    Chat endpoint: Answer questions using knowledge from the ICU book.
    """
    if model is None:
        raise HTTPException(status_code=503, detail="Vertex AI not configured. Please set up Google Cloud credentials.")
    try:
        # Search for relevant knowledge
        relevant_chunks = search_turso_knowledge(request.question, top_k=5)
        
        # Build context from relevant chunks
        context_parts = []
        for i, chunk in enumerate(relevant_chunks, 1):
            page_info = f" (Page {chunk['page_number']})" if chunk['page_number'] else ""
            context_parts.append(f"[Source {i}{page_info}]\n{chunk['text']}\n")
        
        context = "\n---\n".join(context_parts)
        
        # Build prompt for Gemini
        prompt = f"""You are an AI assistant helping ICU nurses with questions about critical care medicine.

Use the following knowledge from an authoritative ICU textbook to answer the question. If the knowledge doesn't contain the answer, say so clearly.

KNOWLEDGE BASE:
{context}

QUESTION: {request.question}

Provide a clear, concise, and clinically accurate answer. Cite which source(s) you used if applicable.
"""
        
        # Generate response using Gemini 2.0
        response = model.generate_content(prompt)
        answer = response.text
        
        # Prepare sources for response
        sources = [
            {
                "text": chunk['text'][:200] + "..." if len(chunk['text']) > 200 else chunk['text'],
                "page_number": chunk['page_number'],
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
        
        # Perform multiple searches to get comprehensive knowledge base coverage
        all_chunks = []
        seen_chunk_ids = set()
        
        # Search 1: Primary diagnosis
        if diagnosis:
            chunks = search_turso_knowledge(diagnosis, top_k=8)
            for chunk in chunks:
                if chunk['id'] not in seen_chunk_ids:
                    all_chunks.append(chunk)
                    seen_chunk_ids.add(chunk['id'])
        
        # Search 2: Ventilator/Respiratory management if applicable
        if vent_settings or patient_data.get("o2-delivery"):
            resp_query = f"{diagnosis} ventilator management respiratory care" if diagnosis else "ventilator management respiratory care"
            chunks = search_turso_knowledge(resp_query, top_k=5)
            for chunk in chunks:
                if chunk['id'] not in seen_chunk_ids:
                    all_chunks.append(chunk)
                    seen_chunk_ids.add(chunk['id'])
        
        # Search 3: Medication/drip management if applicable
        if drips or medications:
            med_query = f"{diagnosis} medication management drips" if diagnosis else "ICU medication management drips"
            chunks = search_turso_knowledge(med_query, top_k=5)
            for chunk in chunks:
                if chunk['id'] not in seen_chunk_ids:
                    all_chunks.append(chunk)
                    seen_chunk_ids.add(chunk['id'])
        
        # Search 4: General ICU care guidelines if we don't have enough chunks
        if len(all_chunks) < 5:
            chunks = search_turso_knowledge("ICU patient care guidelines protocols", top_k=5)
            for chunk in chunks:
                if chunk['id'] not in seen_chunk_ids:
                    all_chunks.append(chunk)
                    seen_chunk_ids.add(chunk['id'])
        
        # Sort by similarity and take top chunks
        all_chunks.sort(key=lambda x: x['similarity'], reverse=True)
        relevant_chunks = all_chunks[:10]  # Use top 10 most relevant chunks
        
        # Build context from relevant chunks with clear source attribution
        context_parts = []
        for i, chunk in enumerate(relevant_chunks, 1):
            page_info = f" (Page {chunk['page_number']})" if chunk['page_number'] else ""
            book_info = f" [From: {chunk.get('book_title', 'Unknown')}]" if chunk.get('book_title') else ""
            similarity = f" [Relevance: {chunk['similarity']:.2f}]" if chunk.get('similarity') else ""
            context_parts.append(f"[Source {i}{book_info}{page_info}{similarity}]\n{chunk['text']}")
        
        guidelines_context = "\n\n---\n\n".join(context_parts) if context_parts else "No specific guidelines found for this diagnosis."
        
        # Build comprehensive prompt for Gemini
        prompt = f"""You are a multi-persona AI assistant for ICU nurses, grounded by authoritative clinical data from an ICU textbook. Generate a professional SBAR (Situation, Background, Assessment, Recommendation) handoff report as a JSON object with keys: "situation", "background", "assessment", "recommendation", and "ai_suggestion".

RELEVANT CLINICAL GUIDELINES FROM TEXTBOOK:
{guidelines_context}

PATIENT DATA:
{patient_data}

INSTRUCTIONS FOR EACH SECTION:
1. "situation": Concise summary of current patient status and immediate concerns
2. "background": Patient history, diagnosis, and relevant past medical information
3. "assessment": System-by-system assessment (Neurological, Cardiovascular, Respiratory, GI/GU, etc.) based on the provided data
4. "recommendation": **CRITICAL: This section MUST be directly based on the RELEVANT CLINICAL GUIDELINES FROM TEXTBOOK above.** Act as an experienced ICU Charge Nurse. Review the textbook guidelines and extract specific, actionable recommendations that apply to this patient's condition. Structure your recommendations by priority (immediate, short-term, ongoing) and reference the relevant guidelines. Include specific monitoring parameters, intervention thresholds, and care protocols from the textbook that are applicable to this patient. If the guidelines mention specific protocols, medications, or interventions for this diagnosis/condition, incorporate them into your recommendations.
5. "ai_suggestion": Act as an ICU Staff Physician (Intensivist). Provide high-level clinical considerations informed by the textbook guidelines above. Structure by system.

CRITICAL SAFETY CHECK: Review the patient's listed allergies against all medications mentioned. If there is a potential conflict, state this as the VERY FIRST point in "ai_suggestion" preceded with "!!! CRITICAL SAFETY ALERT:".

IMPORTANT: 
- **The "recommendation" section is the MOST CRITICAL and MUST be grounded in the textbook guidelines above. Do not provide generic recommendations - extract specific protocols, monitoring requirements, and interventions from the textbook sources.**
- Use the clinical guidelines from the textbook to inform ALL sections, but especially the "recommendation" section
- Be specific and actionable - cite specific parameters, thresholds, or protocols from the textbook when applicable
- Maintain professional medical terminology
- If the textbook guidelines don't contain relevant information for a specific aspect, you may use your clinical knowledge, but prioritize textbook guidance
- Conclude "ai_suggestion" with: "\\n\\nDisclaimer: AI-generated suggestions do not replace professional clinical judgment."

Generate the JSON object now. Return ONLY valid JSON, no markdown formatting.
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
        
        # Ensure all required keys exist
        required_keys = ["situation", "background", "assessment", "recommendation", "ai_suggestion"]
        for key in required_keys:
            if key not in report_json:
                report_json[key] = ""
        
        return GenerateSBARResponse(report=report_json)
    
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

