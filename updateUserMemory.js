// ================================================================
// 📦 Imports
// ================================================================
import { db } from './firebase.js';
import fs from 'fs';


// ================================================================
// 🧠 updateUserMemory(userId, newInfo)
// עדכון זיכרון אישי למשתמש: שמות, תגיות, נושאים, מילות מפתח ועוד
// ------------------------------------------------
// 🟢 קלט:
// - userId (string or number): מזהה ייחודי למשתמש
// - newInfo (object): יכול לכלול name, role, tags, keywords, topics
// 🟣 פלט:
// - כלום (שומר ב-Firestore), לוג קונסול להצלחה או שגיאה
// ================================================================
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

  // ✍️ עדכון שם + תגים + תפקיד
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

  // ✍️ מילות מפתח
  if (newInfo.keywords) {
    for (const [k, v] of Object.entries(newInfo.keywords)) {
      memoryData.memory.keywords[k] = v;
    }
  }

  // ✍️ נושאים כלליים
  if (newInfo.topics) {
    memoryData.memory.topics = Array.from(
      new Set([...(memoryData.memory.topics || []), ...newInfo.topics])
    );
  }

  // 🧼 הסרה אוטומטית של undefined לפני שמירה
  const cleanData = JSON.parse(JSON.stringify(memoryData));

  try {
    await docRef.set(cleanData);
    console.log(`✅ זיכרון עודכן עבור ${userId}`);
  } catch (e) {
    console.error(`🔥 שגיאה בשמירת זיכרון עבור ${userId}:`, e);
  }
}


// ================================================================
// 📤 loadUserMemory(userId)
// שליפת זיכרון קיים של משתמש
// ------------------------------------------------
// 🟢 קלט:
// - userId (string or number)
// 🟣 פלט:
// - אובייקט הזיכרון מה-DB או null אם לא קיים
// ================================================================
export async function loadUserMemory(userId) {
  const docRef = db.collection('user_memory').doc(userId.toString());
  const docSnap = await docRef.get();
  if (!docSnap.exists) return null;
  return docSnap.data();
}


// ================================================================
// 📚 learnFromMessage(uid, gpt)
// לימוד אוטומטי מהודעה שנשלחה: יצירת קשרים, תגיות, הצעות חוזרות
// ------------------------------------------------
// 🟢 קלט:
// - uid (string): מזהה משתמש
// - gpt (object): תוצאה מפוענח GPT – כולל task_name, person_name וכו'
// 🟣 פלט:
// - כלום (שומר ב-Firestore), שולח הודעה אוטומטית אם צריך
// ================================================================
export async function learnFromMessage(uid, gpt) {
  const ref = db.collection('user_memory').doc(uid);
  const memSnap = await ref.get();
  const mem = memSnap.exists ? memSnap.data() : {};

  // 👥 שמירת אנשי קשר
  if (gpt.person_name) {
    mem.contacts ||= {};
    mem.contacts[gpt.person_name] ||= gpt.person_role || '';
  }

  // 🗝️ שמירת מילות מפתח
  if (gpt.task_name) {
    mem.keywords ||= {};
    mem.keywords[gpt.task_name] = 'task';
  }
  if (gpt.note_title) {
    mem.keywords ||= {};
    mem.keywords[gpt.note_title] = 'note';
  }

  // 🔁 מונה משימות + הצעות תדירות חוזרות
  if (gpt.entry_type === 'task') {
    const key = `cnt_${gpt.task_name}`;
    mem.__counters ||= {};
    mem.__counters[key] = 1 + (mem.__counters[key] || 0);

    if (mem.__counters[key] === 3 && gpt.frequency) {
      mem.__pendingSuggest = {
        tag: gpt.task_name,
        freq: gpt.frequency,
        time: gpt.reminder_time
      };

      await sendWhatsappMessage(
        uid.replace('usr_', ''),
        `שמתי לב שאתה מוסיף "${gpt.task_name}" כבר שלוש פעמים.\n` +
        `רוצה שאהפוך את זה להרגל קבוע? ענה "כן" או "לא".`
      );
    }
  }

  // 🧼 הסרה אוטומטית של undefined לפני שמירה
  const cleanMem = JSON.parse(JSON.stringify(mem));

  try {
    await ref.set(cleanMem);
  } catch (e) {
    console.error(`🔥 שגיאה בשמירת learnFromMessage עבור ${uid}:`, e);
  }
}
