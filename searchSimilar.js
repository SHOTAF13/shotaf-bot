import { db } from './firebase.js';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.KEY_GPT });

/**
 * מחשב דמיון קוסיני בין שני וקטורים
 */
function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (normA * normB);
}

export async function getTopK(userId, question, k = 5) {
  // 1. הפוך את השאלה לוקטור embedding
  const { data } = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: question
  });
  const qvec = data[0].embedding;

  // 2. שלוף את כל הוקטורים של המשתמש מ-Firestore
  const snap = await db.collection('vectors')
    .where('user_id', '==', userId)
    .get();

  if (snap.empty) return [];

  const scored = [];

  for (const doc of snap.docs) {
    const { vec, doc_id, doc_type } = doc.data();

    if (!vec || vec.length !== qvec.length) continue;

    const score = cosineSimilarity(qvec, vec); // דמיון, לא מרחק
    scored.push({ doc_id, doc_type, score });
  }

  // 3. מיון לפי ציון יורד והחזרת K תוצאות
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
