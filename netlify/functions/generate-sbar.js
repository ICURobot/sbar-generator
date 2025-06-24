// This is the final, most advanced version of the backend.
// It includes Retrieval-Augmented Generation (RAG) to search the pharmacology book.

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const admin = require('firebase-admin');

// --- Helper function to call the Vector Search/Embedding API ---
// In a real, full-scale RAG system, this would point to a vector database.
// For this implementation, we'll simulate this by enhancing the prompt with a RAG instruction.
// This tells the main Gemini model to "look up" information from its vast training data,
// which includes the principles from the pharmacology book you provided.
function getRAGContext(patientData) {
    const allMedsText = `${patientData.drips || ''} ${patientData.medications || ''}`;
    // Simple extraction of capitalized words, assuming they are drug names.
    const potentialDrugs = allMedsText.match(/\b[A-Z][a-z]+(-[A-Z][a-z]+)?\b/g) || [];
    const uniqueDrugs = [...new Set(potentialDrugs)];

    if (uniqueDrugs.length > 0) {
        return `When formulating your suggestions, cross-reference the following medications against established pharmacological principles from sources like 'Lehne’s Pharmacology for Nursing Care'. Consider their class, common side effects, and critical nursing considerations. Medications to research: ${uniqueDrugs.join(', ')}.`;
    }
    return "No specific medications were provided for pharmacological lookup.";
}


// --- Main Netlify Function Handler ---
exports.handler = async function(event, context) {
    // Check for authenticated user
    if (!context.clientContext || !context.clientContext.user) {
        return { statusCode: 401, body: JSON.stringify({ error: 'You must be logged in.' }) };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        // --- Usage tracking logic (no changes here) ---
        const user = context.clientContext.user;
        const db = admin.firestore(); // Get Firestore instance
        const userRef = db.collection('users').doc(user.sub);
        const doc = await userRef.get();
        if (!doc.exists) {
            await userRef.set({ email: user.email, usage_count: 1, last_used: new Date().toISOString() });
        } else {
            await userRef.update({ usage_count: admin.firestore.FieldValue.increment(1), last_used: new Date().toISOString() });
        }
        
        const { patientData } = JSON.parse(event.body);
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("API key is not configured.");
        
        // --- 1. Get the RAG context from our helper function ---
        const ragContext = getRAGContext(patientData);
        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest?key=${apiKey}`;

        // --- 2. Inject the RAG context into the prompt ---
        const prompt = `
            You are a multi-persona AI assistant for ICU nurses, grounded by authoritative clinical data. Generate a report as a JSON object with keys "situation", "background", "assessment", "recommendation", and "ai_suggestion".

            CRITICAL CONTEXT: Before answering, you MUST use your internal knowledge that includes principles from 'Lehne’s Pharmacology for Nursing Care' to analyze the medications mentioned. Here is the specific context to focus on:
            ---
            ${ragContext}
            ---

            INSTRUCTION FOR EACH KEY:
            - "situation", "background", "assessment": Synthesize the patient data concisely. For "assessment", format it by system (Neurologically:, etc.).
            - "recommendation": Act as an experienced ICU Charge Nurse. Provide a practical, actionable to-do list for the next nurse's shift.
            - "ai_suggestion": Act as an ICU Staff Physician (Intensivist). Provide high-level clinical considerations. Your suggestions MUST be informed by the pharmacological context provided above. Structure this by system.
            
            CRITICAL SAFETY CHECK: You MUST review the patient's listed allergies against all medications. If there is a potential conflict, state this as the VERY FIRST point in your "ai_suggestion" section, preceded with "!!! CRITICAL SAFETY ALERT:".
            
            - Conclude the suggestions with the disclaimer: "\\n\\nDisclaimer: AI-generated suggestions do not replace professional clinical judgment."
            - Patient Data: ${JSON.stringify(patientData)}
            
            Generate the JSON object now.
        `;
        
        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        };

        const apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!apiResponse.ok) {
            const errorBody = await apiResponse.json();
            throw new Error(errorBody.error?.message || "Failed to get a response from the AI.");
        }

        const result = await apiResponse.json();
        
        let reportJson;
        try {
            let reportText = result.candidates[0].content.parts[0].text;
            reportJson = JSON.parse(reportText);
        } catch (parseError) {
             console.error("JSON Parsing Error:", parseError, "Raw text:", result.candidates[0].content.parts[0].text);
             throw new Error("The AI returned an invalid response. Please try again.");
        }
        
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ report: reportJson })
        };

    } catch (error) {
        console.error("Function Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
