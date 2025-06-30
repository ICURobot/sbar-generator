// This file has been updated with a 2-step AI process for better accuracy.
// Step 1: Clean the raw transcript.
// Step 2: Extract data from the cleaned transcript.

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
        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        // --- STEP 1: AI-POWERED TRANSCRIPT CLEANING ---
        // This prompt asks the AI to act as a medical transcriptionist to fix errors.
        const cleaningPrompt = `
            You are a highly skilled medical transcriptionist AI. Your task is to correct the following raw, potentially inaccurate voice-to-text transcript from an ICU nurse.
            - Correct any spelling and grammatical errors.
            - Most importantly, correct any misspelled medical terminology, drug names, or clinical acronyms to their proper medical spelling. For example, if you see "leave a fed", correct it to "levophed". If you see "proper fall", correct it to "propofol".
            - Do not summarize. Return only the corrected, clean version of the full transcript.

            Raw Transcript:
            ---
            ${transcript}
            ---
        `;

        const cleaningPayload = {
            contents: [{ parts: [{ text: cleaningPrompt }] }]
        };

        const cleaningResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cleaningPayload)
        });

        if (!cleaningResponse.ok) {
            throw new Error("AI failed during the transcript cleaning step.");
        }

        const cleaningResult = await cleaningResponse.json();
        const cleanedTranscript = cleaningResult.candidates[0].content.parts[0].text;


        // --- STEP 2: DATA EXTRACTION FROM THE CLEANED TRANSCRIPT ---
        // This prompt is the same as before, but now uses the "cleanedTranscript".
        const extractionPrompt = `
            You are an expert data extraction AI. Your task is to analyze the following CLEANED verbal report from an ICU nurse and parse the information into a structured JSON object.
            The JSON object keys MUST correspond to the form field IDs.
            The keys are: room, name, age-sex, md, allergies, code-status, isolation, diagnosis, history, loc, pupils, sedation-pain, delirium-score, evd, temperature, hr-rhythm, bp-map, pulses, pacemaker, iabp, o2-delivery, vent-settings, trach-airway, breath-sounds, diet, abdomen, urine-output, iv-lines, art-line, central-line, drains-tubes, skin-integrity, traction-fixators, fractures-braces, labs-diagnostics, family-communication, drips, medications, plan.
            
            Extract the relevant information for each key from the text. If information for a key is not present, omit the key from the final JSON object.
            
            Cleaned Transcript to analyze:
            ---
            ${cleanedTranscript}
            ---

            Generate the JSON object now.
        `;
        
        const extractionPayload = {
            contents: [{ parts: [{ text: extractionPrompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
            }
        };

        const extractionResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(extractionPayload)
        });

        if (!extractionResponse.ok) {
            const errorBody = await extractionResponse.json();
            throw new Error(errorBody.error?.message || "Failed to get a response from the AI during data extraction.");
        }

        const extractionResult = await extractionResponse.json();
        
        let formDataJson;
        try {
            let reportText = extractionResult.candidates[0].content.parts[0].text;
            formDataJson = JSON.parse(reportText);
        } catch (parseError) {
             throw new Error("The AI returned an invalid JSON response after cleaning. Please try again.");
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
