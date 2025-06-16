// This file lives in the `netlify/functions` directory.
// This is the SECURE, GATED version of the function.
// It checks for a valid user before running.

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

exports.handler = async function(event, context) {
    // 1. Check if the user is authenticated.
    // The `context.clientContext.user` object is automatically populated by Netlify Identity.
    if (!context.clientContext || !context.clientContext.user) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: 'You must be logged in to generate a report.' })
        };
    }

    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
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
