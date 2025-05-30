import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';

// אתחול Firebase
const serviceAccount = JSON.parse(fs.readFileSync('./firebase/serviceAccountKey.json', 'utf8'));

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

export async function loadUserMemory(userId) {
  const docRef = db.collection('user_memory').doc(userId.toString());
  const docSnap = await docRef.get();

  if (!docSnap.exists) {
    return {
      user_id: userId,
      memory: { names: {}, keywords: {}, topics: [] }
    };
  }

  return docSnap.data();
}
