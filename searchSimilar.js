import { db } from './firebase.js';
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.KEY_GPT });

export async function getTopK(userId, question, k = 5){
  const { data } = await openai.embeddings.create({
    model : 'text-embedding-3-small',
    input : question
  });
  const qvec = data[0].embedding;

  // pgvector: <->  = cosine distance
  const rows = await sql`
    SELECT doc_id, doc_type, 1 - (vec <-> ${qvec}) AS score
    FROM vectors
    WHERE user_id = ${userId}
    ORDER BY score DESC
    LIMIT ${k};
  `;
  return rows;  // [{doc_id, doc_type, score}, ...]
}
