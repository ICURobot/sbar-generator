// This file lives in the `netlify/functions` directory.
// This version returns a structured JSON object for beautiful formatting on the frontend.

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const admin = require('firebase-admin');

// Initialize Firebase Admin
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

        const { patientData } = JSON.parse(event.body);
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) throw new Error("API key is not configured.");
        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        // UPDATED PROMPT: Asks for a JSON object.
        const prompt = `
            You are an expert Canadian ICU nurse. Based on the provided patient data, generate a report as a JSON object.
            The JSON object must have these exact keys: "situation", "background", "assessment", "recommendation", and "suggestions".
            - The SBAR sections should be concise and professional for handoff.
            - The "suggestions" key should contain a few bullet points for clinical considerations, followed by the disclaimer.
            - Use Canadian medical terminology. Do not include any extra text or markdown formatting outside of the JSON structure.

            Patient Data:
            ${JSON.stringify(patientData, null, 2)}

            Generate the JSON object now:
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
        
        // Extract the text and clean it up to ensure it's valid JSON
        let reportText = result.candidates[0].content.parts[0].text;
        reportText = reportText.replace(/```json\n/g, '').replace(/\n```/g, '').trim();
        
        // Parse the text to a JSON object to send to the frontend
        const reportJson = JSON.parse(reportText);
        
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ report: reportJson }) // Send the JSON object
        };

    } catch (error) {
        console.error("Function Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
