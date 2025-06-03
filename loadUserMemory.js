import { db } from './firebase.js';

// טעינת זיכרון משתמש
export async function loadUserMemory(userId) {
  try {
    const docRef = db.collection('user_memory').doc(userId.toString());
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      console.log(`📭 אין עדיין זיכרון ל־${userId} – מחזיר ברירת מחדל`);
      return {
        user_id: userId,
        memory: { names: {}, keywords: {}, topics: [] }
      };
    }

    return docSnap.data();
  } catch (err) {
    console.error("❌ שגיאה בקריאת זיכרון מ־Firestore:", err);
    return {
      user_id: userId,
      memory: { names: {}, keywords: {}, topics: [] }
    };
  }
}
