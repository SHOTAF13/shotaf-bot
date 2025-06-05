import admin   from 'firebase-admin';
import { Storage } from '@google-cloud/storage';

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS_JSON);

if (!admin.apps.length) {
  admin.initializeApp({
    credential   : admin.credential.cert(serviceAccount),
    storageBucket: 'shotaf-bot.appspot.com'  // ← שם הבאקט שלך
  });
}

export const db      = admin.firestore();
export const storage = new Storage().bucket('shotaf-bot.appspot.com');  // ← מציין את הבאקט המפורש
