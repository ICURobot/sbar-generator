// This file lives in the `netlify/functions` directory.
// This is the SECURE, GATED version with USAGE TRACKING.
// It checks for a valid user and tracks their usage in Firestore.

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
// 1. Add the Firebase Admin SDK
const admin = require('firebase-admin');

// 2. Initialize Firebase Admin, but only if it hasn't been already.
// This is important for serverless environments.
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // The private key needs special handling to parse correctly from an environment variable.
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

exports.handler = async function(event, context) {
    if (!context.clientContext || !context.clientContext.user) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: 'You must be logged in to generate a report.' })
        };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        // --- This is the new usage tracking logic ---
        const user = context.clientContext.user;
        const userRef = db.collection('users').doc(user.sub); // 'sub' is the unique user ID from Netlify Identity
        
        const doc = await userRef.get();
        if (!doc.exists) {
            // If the user is new, create their record
            await userRef.set({
                email: user.email,
                usage_count: 1,
                last_used: new Date().toISOString(),
            });
        } else {
            // If they exist, increment their usage count
            await userRef.update({
                usage_count: admin.firestore.FieldValue.increment(1),
                last_used: new Date().toISOString(),
            });
        }
        // --- End of new usage tracking logic ---


        const { patientData } = JSON.parse(event.body);
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            throw new Error("API key is not configured.");
        }
        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        const prompt = `
            You are an expert Canadian ICU nurse acting as a clinical co-pilot.
            Your task is to perform two actions based on the provided patient data:
            1. Generate a clear, concise, and professional SBAR (Situation, Background, Assessment, Recommendation) report suitable for handoff.
            2. After the SBAR, create a new section titled "Clinical Considerations & Suggestions". In this section, analyze the patient data for potential issues, concerning trends, or things that might need attention. Provide a few bullet-point suggestions for the nurse to consider (e.g., "Urine output seems low, consider fluid challenge if BP allows," or "Monitor potassium closely given the recent lab value.").

            IMPORTANT: Always conclude with the disclaimer: "Disclaimer: These are AI-generated suggestions and do not replace professional clinical judgment."

            Use Canadian medical terminology and units.

            Patient Data:
            ${JSON.stringify(patientData, null, 2)}

            Generate the report now:
        `;

        const payload = {
            contents: [{
                parts: [{ text: prompt }]
            }]
        };

        const apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!apiResponse.ok) {
            const errorBody = await apiResponse.json();
            console.error("Gemini API Error:", errorBody);
            throw new Error(errorBody.error?.message || "Failed to get a response from the AI.");
        }

        const result = await apiResponse.json();
        const reportText = result.candidates[0].content.parts[0].text;
        
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ report: reportText })
        };

    } catch (error) {
        console.error("Function Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
