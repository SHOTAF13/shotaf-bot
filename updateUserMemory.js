// 📦 ייבוא ספריות
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';

// 🔐 קריאת קובץ מפתחות הסרביס
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS_JSON);


// 🚀 אתחול Firebase
initializeApp({
  credential: cert(serviceAccount)
});

// 🔗 חיבור ל-Firestore
const db = getFirestore();

// 🧠 עדכון זיכרון משתמש
export async function updateUserMemory(userId, newInfo = {}) {
  const docRef = db.collection('user_memory').doc(userId.toString());

  let memoryData = {
    user_id: userId,
    memory: {
      names: {},
      keywords: {},
      topics: []
    }
  };

  const docSnap = await docRef.get();
  if (docSnap.exists) {
    memoryData = docSnap.data();
  }

  if (newInfo.name) {
    const existing = memoryData.memory.names[newInfo.name] || {
      mentions: 0,
      tags: [],
      role: '',
      last_used: ''
    };

    memoryData.memory.names[newInfo.name] = {
      role: newInfo.role || existing.role,
      mentions: existing.mentions + 1,
      tags: Array.from(new Set([...(existing.tags || []), ...(newInfo.tags || [])])),
      last_used: new Date().toISOString().split('T')[0]
    };
  }

  if (newInfo.keywords) {
    for (const [k, v] of Object.entries(newInfo.keywords)) {
      memoryData.memory.keywords[k] = v;
    }
  }

  if (newInfo.topics) {
    memoryData.memory.topics = Array.from(
      new Set([...(memoryData.memory.topics || []), ...newInfo.topics])
    );
  }

  await docRef.set(memoryData);
  console.log(`✅ זיכרון עודכן עבור ${userId}`);
}

// 📤 טעינת זיכרון משתמש קיים
export async function loadUserMemory(userId) {
  const docRef = db.collection('user_memory').doc(userId.toString());
  const docSnap = await docRef.get();
  if (!docSnap.exists) return null;
  return docSnap.data();
}
