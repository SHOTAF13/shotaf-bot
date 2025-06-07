// 📦 ייבוא ספריות
import { db } from './firebase.js';
import fs from 'fs';



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


export async function learnFromMessage(uid, gpt){
  const ref = db.collection('user_memory').doc(uid);
  const memSnap = await ref.get();
  const mem = memSnap.exists ? memSnap.data() : {};

  /* ── contacts ── */
  if (gpt.person_name){
    mem.contacts ||= {};
    mem.contacts[gpt.person_name] ||= gpt.person_role || '';
  }

  /* ── keywords ── */
  if (gpt.task_name){
    mem.keywords ||= {};
    mem.keywords[gpt.task_name] = 'task';
  }
  if (gpt.note_title){
    mem.keywords ||= {};
    mem.keywords[gpt.note_title] = 'note';
  }

  /* ── counters + auto-suggest ── */
  if (gpt.entry_type === 'task'){
    const key = `cnt_${gpt.task_name}`;
    mem.__counters ||= {};
    mem.__counters[key] = 1 + (mem.__counters[key]||0);

    if (mem.__counters[key] === 3 && gpt.frequency){          // ✔ הגיע ל-3
      mem.__pendingSuggest = { tag:gpt.task_name,
                               freq:gpt.frequency,
                               time:gpt.reminder_time };
      await sendWhatsappMessage(
        uid.replace('usr_',''),
        `שמתי לב שאתה מוסיף "${gpt.task_name}" כבר שלוש פעמים.\n` +
        `רוצה שאהפוך את זה להרגל קבוע? ענה "כן" או "לא".`
      );
    }
  }
}

  await ref.set(mem);
