import { db } from './firebase.js';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.KEY_GPT });

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (normA * normB);
}

export async function getTopK(userId, question, k = 5) {
  const { data } = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: question
  });
  const qvec = data[0].embedding;

  const snap = await db.collection('vectors')
    .where('user_id', '==', userId)
    .get();

  if (snap.empty) return [];

  const scored = [];

  for (const doc of snap.docs) {
    const { vec, doc_id, doc_type } = doc.data();

    if (!vec || vec.length !== qvec.length) continue;

    const score = cosineSimilarity(qvec, vec);
    scored.push({ doc_id, doc_type, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
