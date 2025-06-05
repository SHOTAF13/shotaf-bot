// utils/normalize.js   (ESM)

import { db } from './firebase.js';

// Helper
const slugify = (str = '') =>
  str
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '');

// -- קטגוריה --------------------------------------------------
export async function ensureCategory(raw = 'כללי') {
  raw = raw.replace(/^["'\u201C\u201D]+|["'\u201C\u201D]+$/g, '');
  const slug = slugify(raw) || 'general';

  const ref = db.collection('categories').doc(slug);
  const doc = await ref.get();
  if (!doc.exists) {
    await ref.set({ display: raw, emoji: '' });
  }
  return slug;                     // ← מחזיר ID
}

// -- אדם -------------------------------------------------------
export async function ensurePerson(name, role) {
  if (!name) return null;

  name = name.replace(/^["'\u201C\u201D]+|["'\u201C\u201D]+$/g, '');
  const slug = slugify(name);

  if (!slug) return null;
  
  const ref = db.collection('persons').doc(slug);
  await ref.set({ name, role }, { merge: true });
  return slug;
}
