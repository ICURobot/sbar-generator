// This is the advanced version with live Health Canada Drug Product Database integration.

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const admin = require('firebase-admin');

// Initialize Firebase Admin (if not already initialized)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

// --- NEW HELPER FUNCTION: Fetches data from Health Canada ---
async function getDrugInfo(drugName) {
    try {
        // Health Canada Drug Product Database API endpoint
        const url = `https://health-products.canada.ca/api/drug/drugproduct/?brandname=${encodeURIComponent(drugName)}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        
        const data = await response.json();
        if (data && data.length > 0) {
            // Return key info for the first match
            const drug = data[0];
            return {
                brand_name: drug.brand_name,
                class: drug.class_name,
                active_ingredients: drug.active_ingredients.map(ing => ing.ingredient_name).join(', ')
            };
        }
        return null;
    } catch (error) {
        console.error(`Error fetching drug info for ${drugName}:`, error);
        return null; // Don't crash if the API fails
    }
}


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
        const userRef = db.collection('users').doc(user.sub);
        // ... (rest of usage tracking code is the same)
        const doc = await userRef.get();
        if (!doc.exists) {
            await userRef.set({ email: user.email, usage_count: 1, last_used: new Date().toISOString() });
        } else {
            await userRef.update({ usage_count: admin.firestore.FieldValue.increment(1), last_used: new Date().toISOString() });
        }
        
        const { patientData } = JSON.parse(event.body);
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) throw new Error("API key is not configured.");
        
        // --- NEW: Fetch Drug Information ---
        let drugInfoText = "No specific drug information was queried or found.";
        const medicationsToQuery = new Set();
        // A simple way to extract potential drug names from the text fields
        const allMedsText = `${patientData.drips || ''} ${patientData.medications || ''}`;
        const potentialDrugs = allMedsText.match(/\b[A-Z][a-z]+(?:-[A-Z][a-z]+)?\b/g) || [];
        potentialDrugs.forEach(drug => medicationsToQuery.add(drug));

        if (medicationsToQuery.size > 0) {
            const drugInfoPromises = Array.from(medicationsToQuery).map(getDrugInfo);
            const drugResults = await Promise.all(drugInfoPromises);
            const foundDrugs = drugResults.filter(Boolean); // Filter out any null results
            if (foundDrugs.length > 0) {
                drugInfoText = "Authoritative data from Health Canada's Drug Product Database:\n" + 
                               foundDrugs.map(d => `- ${d.brand_name} (Class: ${d.class}, Ingredients: ${d.active_ingredients})`).join('\n');
            }
        }
        // --- END of new drug info logic ---

        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        // --- UPDATED PROMPT with Drug Info ---
        const prompt = `
            You are a multi-persona AI assistant for ICU nurses, grounded by official data. Generate a report as a JSON object with keys "situation", "background", "assessment", "recommendation", and "ai_suggestion".

            INSTRUCTION FOR EACH KEY:
            - "situation", "background", "assessment": Synthesize the patient data concisely. For "assessment", format it by system (Neurologically:, etc.).
            - "recommendation": Act as an experienced ICU Charge Nurse. Provide a practical, actionable to-do list.
            - "ai_suggestion": Act as an ICU Staff Physician (Intensivist). Provide high-level clinical considerations. Structure this by system (Neurological:, etc.).
            
            Use the following authoritative Health Canada data to inform your recommendations and suggestions:
            ${drugInfoText}

            Patient Data Entered by Nurse:
            ${JSON.stringify(patientData)}
            
            Generate the JSON object now. Ensure the output is only the JSON object itself.
        `;
        
        const payload = {
            contents: [{ parts: [{ text: prompt }] }]
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
            reportText = reportText.replace(/```json\n/g, '').replace(/\n```/g, '').trim();
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
