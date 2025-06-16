
// This file lives in the `netlify/functions` directory
// It is a Node.js function that will run on Netlify's servers.

// We need 'fetch' in a Node.js environment. `node-fetch` is a common choice.
// You'll need to add it to your project's dependencies.
// Run `npm install node-fetch` in your project folder.
const fetch = require('node-fetch');

exports.handler = async function(event, context) {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { patientData } = JSON.parse(event.body);

        // Your secret API key is retrieved from Netlify's environment variables.
        // It is NEVER exposed to the frontend.
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            throw new Error("API key is not configured.");
        }
        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        const prompt = `
            You are an expert Canadian ICU nurse preparing a verbal handoff report for another nurse.
            Based on the following patient data, generate a clear, concise, and professional SBAR (Situation, Background, Assessment, Recommendation) report.
            Synthesize the data into a coherent narrative. Do not just list the data. Focus on the most critical information.
            Use Canadian medical terminology and units (e.g., mmol/L).

            Patient Data:
            ${JSON.stringify(patientData, null, 2)}

            Generate the SBAR report:
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
