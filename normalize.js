// normalize.js  (ESM מלא)

import { db } from './firebase.js';

const slugify = (s = '') =>
  s.toLowerCase()
   .trim()
   .replace(/[^\p{L}\p{N}\s-]/gu, '')      // משאיר אותיות מכל שפה ומספרים
   .replace(/\s+/g, '');

export async function ensureCategory(raw = 'כללי') {
  raw = raw.replace(/^["'\u201C\u201D]+|["'\u201C\u201D]+$/g, '');
  let slug = slugify(raw);
  if (!slug) slug = 'general';             // שמים משהו ולא יוצרים null

  // לוג לצורכי דיבוג
  console.log('[ensureCategory] raw:', raw, '→ slug:', slug);

  const ref = db.collection('categories').doc(slug);
  const doc = await ref.get();
  if (!doc.exists) await ref.set({ display: raw, emoji: '' });
  return slug;
}

export async function ensurePerson(name, role) {
  if (!name) return null;
  name = name.replace(/^["'\u201C\u201D]+|["'\u201C\u201D]+$/g, '');
  const slug = slugify(name);

  console.log('[ensurePerson] name:', name, '→ slug:', slug);

  if (!slug) return null;                  // אם נשאר ריק – פשוט מדלגים
  const ref = db.collection('persons').doc(slug);
  await ref.set({ name, role }, { merge: true });
  return slug;
}
