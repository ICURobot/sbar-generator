// This file lives in the `netlify/functions` directory.
// This is the simplified version where suggestions are always included.

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
        // --- End of usage tracking logic ---

        const { patientData } = JSON.parse(event.body); // SIMPLIFIED: No longer need includeSuggestions
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) throw new Error("API key is not configured.");
        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest?key=${apiKey}`;

        // SIMPLIFIED PROMPT: Always asks for suggestions
        const prompt = `
            You are an expert Canadian ICU Charge Nurse. Based on the provided patient data, generate a report as a JSON object.
            The JSON object must have these exact keys: "situation", "background", "assessment", "recommendation", and "suggestions".
            - For the "assessment" key, structure it by system (Neurologically, etc.).
            - For the "suggestions" key, act as a clinical safety net. Do NOT state obvious standard-of-care. Focus ONLY on high-priority issues, critical omissions, or specific, actionable next steps. Format this section as a bulleted list using '\\n- ' for each new point.
            - Conclude the suggestions with the disclaimer: "Disclaimer: AI-generated suggestions do not replace professional clinical judgment."
            - Patient Data: ${JSON.stringify(patientData)}
            Generate the JSON object now.
        `;
        
        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                // SIMPLIFIED SCHEMA: Always includes suggestions
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        situation: { type: "STRING" },
                        background: { type: "STRING" },
                        assessment: { type: "STRING" },
                        recommendation: { type: "STRING" },
                        suggestions: { type: "STRING" }
                    },
                    required: ["situation", "background", "assessment", "recommendation", "suggestions"]
                },
            },
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
        const reportText = result.candidates[0].content.parts[0].text;
        const reportJson = JSON.parse(reportText);
        
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
