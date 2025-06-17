// This is a NEW file. Create it at: netlify/functions/form-data.js
// It handles saving and loading form drafts to/from Firestore.

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
    // Ensure user is authenticated
    if (!context.clientContext || !context.clientContext.user) {
        return { statusCode: 401, body: JSON.stringify({ error: 'You must be logged in.' }) };
    }

    const user = context.clientContext.user;
    const userRef = db.collection('users').doc(user.sub);

    // Handle SAVING form data (POST request)
    if (event.httpMethod === 'POST') {
        try {
            const { formData } = JSON.parse(event.body);
            await userRef.set({
                formData: formData, // Save the entire form data object
                formLastUpdated: new Date().toISOString()
            }, { merge: true }); // Use merge to avoid overwriting usage_count etc.

            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'Draft saved successfully' })
            };
        } catch (error) {
            console.error("Error saving draft:", error);
            return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
        }
    }

    // Handle LOADING form data (GET request)
    if (event.httpMethod === 'GET') {
        try {
            const doc = await userRef.get();
            if (!doc.exists || !doc.data().formData) {
                return { statusCode: 404, body: JSON.stringify({ message: 'No saved draft found.' }) };
            }
            return {
                statusCode: 200,
                body: JSON.stringify({ formData: doc.data().formData })
            };
        } catch (error) {
            console.error("Error loading draft:", error);
            return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
        }
    }

    // Disallow other methods
    return { statusCode: 405, body: 'Method Not Allowed' };
};
