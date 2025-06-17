// This is the final, polished version with multiple AI personas.

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
        const doc = await userRef.get();
        if (!doc.exists) {
            await userRef.set({ email: user.email, usage_count: 1, last_used: new Date().toISOString() });
        } else {
            await userRef.update({ usage_count: admin.firestore.FieldValue.increment(1), last_used: new Date().toISOString() });
        }
        
        const { patientData } = JSON.parse(event.body);
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) throw new Error("API key is not configured.");
        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        // --- FINAL, MULTI-PERSONA PROMPT ---
        const prompt = `
            You are a multi-persona AI assistant for ICU nurses. Generate a report as a JSON object with keys "situation", "background", "assessment", "recommendation", and "ai_suggestion".

            INSTRUCTION FOR EACH KEY:
            - "situation", "background", "assessment": Synthesize the data concisely. For "assessment", format it by system (Neurologically:, Cardiovascularly:, etc.).
            - "recommendation": Act as an experienced ICU Charge Nurse. Provide a practical, actionable to-do list for the next nurse's shift.
            - "ai_suggestion": Act as an ICU Staff Physician (Intensivist). Provide high-level clinical considerations and diagnostic thoughts. Structure this by system (Neurological:, Cardiovascular:, etc.). Do NOT state obvious standard-of-care. Conclude with the disclaimer: "\\n\\nDisclaimer: AI-generated suggestions do not replace professional clinical judgment."

            - Use Canadian medical terminology.
            - Patient Data: ${JSON.stringify(patientData)}
            
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
