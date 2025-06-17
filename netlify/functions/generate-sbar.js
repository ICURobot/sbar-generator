// This file lives in the `netlify/functions` directory.
// This is the upgraded version using the Gemini 1.5 Pro model and advanced prompting.

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

        const { patientData, includeSuggestions } = JSON.parse(event.body);
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) throw new Error("API key is not configured.");
        
        // --- 1. UPGRADED MODEL ---
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest?key=${apiKey}`;

        // --- 2. ADVANCED PROMPT ---
        let prompt = `
            You are an expert Canadian ICU Charge Nurse with 20 years of experience. Your task is to generate a report as a JSON object with the keys "situation", "background", "assessment", and "recommendation".
            
            - The report must be extremely concise, professional, and targeted for handoff to another experienced ICU nurse.
            - For the "assessment", structure it by system (Neurologically, Cardiovascularly, etc.).
            - Synthesize the data. Do not simply list what was provided.
        `;
        
        // Conditionally add the suggestions part based on the user's choice
        if (includeSuggestions) {
            prompt += `
            
            After the SBAR, add a "suggestions" key to the JSON object. 
            In this section, act as a clinical safety net. Do NOT state obvious standard-of-care. Focus ONLY on high-priority issues, critical omissions, or specific, actionable next steps. For example, instead of "monitor electrolytes," suggest "suggest follow-up potassium level in 4 hours post-repletion."
            
            IMPORTANT: Conclude the suggestions with the disclaimer: "Disclaimer: AI-generated suggestions do not replace professional clinical judgment."
            `;
        }

        prompt += `
            Here is the patient data:
            ${JSON.stringify(patientData, null, 2)}

            Generate the JSON object now. Do not include any extra text or markdown formatting outside of the JSON structure.
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
        
        let reportText = result.candidates[0].content.parts[0].text;
        reportText = reportText.replace(/```json\n/g, '').replace(/\n```/g, '').trim();
        
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
