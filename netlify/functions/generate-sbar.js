// This is the final, simplified, and reliable version using Gemini 2.0 Flash.
// It includes a highly specific prompt to fix the [object Object] formatting issue.

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

        // --- FINAL, CORRECTED PROMPT ---
        const prompt = `
            You are an expert Canadian ICU Charge Nurse. Generate a report as a JSON object with keys "situation", "background", "assessment", "recommendation", and "suggestions".

            CRITICAL INSTRUCTION FOR "assessment": The value for the "assessment" key MUST be a single string. Inside this string, format the system assessments with each system on a new line, like this: "Neurologically: ...\\nCardiovascularly: ...\\nRespiratory: ...". DO NOT create a nested JSON object for the assessment.

            - For "suggestions", provide only high-priority, actionable next steps, not standard care.
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
