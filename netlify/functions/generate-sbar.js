// This is the simplified, reliable version using Gemini 2.0 Flash.
// It keeps the advanced prompt but removes complex features to ensure stability.

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
        
        // --- REVERTED TO GEMINI 2.0 FLASH for speed and reliability ---
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        // Using the advanced prompt but asking for a clean, parsable JSON string
        const prompt = `
            You are an expert Canadian ICU Charge Nurse. Your task is to generate a report as a JSON object with the keys "situation", "background", "assessment", "recommendation", and "suggestions".
            - The report must be concise and professional for handoff to another experienced ICU nurse.
            - For the "assessment", structure it by system (Neurologically, Cardiovascularly, etc.).
            - For the "suggestions" section, act as a clinical safety net. Do NOT state obvious standard-of-care. Focus ONLY on high-priority issues or critical omissions.
            - Conclude the suggestions with the disclaimer: "Disclaimer: AI-generated suggestions do not replace professional clinical judgment."
            - Patient Data: ${JSON.stringify(patientData)}
            Generate the JSON object now. Ensure the output is only the JSON object itself, with no extra text or markdown.
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
            // Get the raw text and clean it just in case
            let reportText = result.candidates[0].content.parts[0].text;
            reportText = reportText.replace(/```json\n/g, '').replace(/\n```/g, '').trim();
            reportJson = JSON.parse(reportText);
        } catch (parseError) {
             console.error("JSON Parsing Error:", parseError);
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
