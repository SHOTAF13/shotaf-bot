
const { db } = require('../firebase');

const slugify = (str) =>
  str
    .toLowerCase()
    .trim()
    .normalize('NFKD')          // מוריד ניקוד
    .replace(/[^\w\s-]/g, '')   // מסיר אימוג׳י/סימנים
    .replace(/\s+/g, '');       // בלי רווחים

// יוצר/מאשר קיום קטגוריה ומחזיר את ה-slug
async function ensureCategory(raw) {
  if (!raw) return 'general';
  const slug = slugify(raw);
  const ref  = db.collection('categories').doc(slug);
  const doc  = await ref.get();
  if (!doc.exists) {
    await ref.set({ display: raw.replace(/[^א-ת ]/g,''), emoji: '' });
  }
  return slug;                // מחזירים את ה-ID
}

// אותו דבר לאדם
async function ensurePerson(name, role) {
  if (!name) return null;
  const slug = slugify(name);
  const ref  = db.collection('persons').doc(slug);
  await ref.set({ name, role }, { merge: true });   // merge אם כבר קיים
  return slug;
}

module.exports = { slugify, ensureCategory, ensurePerson };
