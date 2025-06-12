import OpenAI from 'openai';
import { db } from './firebase.js';           // wrapper ל-pg


const openai = new OpenAI({ apiKey: process.env.KEY_GPT });

export async function storeEmbedding(userId, text, docId, docType){
  // ① הפקת embedding
  const { data } = await openai.embeddings.create({
     model : 'text-embedding-3-small',
     input : text
  });
  const vec = data[0].embedding;          // מערך 1536 מספרים

  // ② שמירה בטבלה vectors(user_id, doc_id, doc_type, vec)
  await sql`
    INSERT INTO vectors VALUES (${userId}, ${docId}, ${docType}, ${vec})
    ON CONFLICT (doc_id) DO NOTHING
  `;
}
