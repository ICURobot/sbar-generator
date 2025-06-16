// This file lives in the `netlify/functions` directory
// It is a Node.js function that will run on Netlify's servers.
// This version includes AI-powered clinical suggestions.

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

exports.handler = async function(event, context) {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { patientData } = JSON.parse(event.body);

        // Your secret API key is retrieved from Netlify's environment variables.
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            throw new Error("API key is not configured.");
        }
        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        // UPDATED PROMPT: Now asks for clinical suggestions in a new section.
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
        
        // Send the generated report back to the frontend
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
