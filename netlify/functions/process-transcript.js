// This is a NEW file. Create it at: netlify/functions/process-transcript.js
// It receives a block of text and uses the AI to parse it into structured form data.

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

exports.handler = async function(event, context) {
    // Check for authenticated user
    if (!context.clientContext || !context.clientContext.user) {
        return { statusCode: 401, body: JSON.stringify({ error: 'You must be logged in.' }) };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { transcript } = JSON.parse(event.body);
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) throw new Error("API key is not configured.");
        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest?key=${apiKey}`;

        // This prompt instructs the AI to act as a data parser.
        const prompt = `
            You are an expert data extraction AI. Your task is to analyze the following verbal report from an ICU nurse and parse the information into a structured JSON object.
            The JSON object keys MUST correspond to the form field IDs.
            The keys are: room, name, age-sex, md, allergies, code-status, isolation, diagnosis, history, loc, pupils, sedation-pain, delirium-score, evd, temperature, hr-rhythm, bp-map, pulses, pacemaker, iabp, o2-delivery, vent-settings, trach-airway, breath-sounds, diet, abdomen, urine-output, iv-lines, art-line, central-line, drains-tubes, skin-integrity, traction-fixators, fractures-braces, labs-diagnostics, family-communication, drips, medications, plan.
            
            Extract the relevant information for each key from the text. If information for a key is not present, omit the key from the final JSON object.
            
            Transcript to analyze:
            ---
            ${transcript}
            ---

            Generate the JSON object now.
        `;
        
        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
            }
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
        
        let formDataJson;
        try {
            let reportText = result.candidates[0].content.parts[0].text;
            formDataJson = JSON.parse(reportText);
        } catch (parseError) {
             throw new Error("The AI returned an invalid response. Please try again.");
        }
        
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ formData: formDataJson })
        };

    } catch (error) {
        console.error("Function Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
