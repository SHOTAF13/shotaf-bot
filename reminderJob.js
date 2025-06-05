/* ------------------------------------------------------------------ */
/*                               IMPORTS                              */
/* ------------------------------------------------------------------ */
import dotenv            from 'dotenv';
import axios             from 'axios';
import { db }            from './firebase.js';
import OpenAI            from 'openai';

dotenv.config();

/* ------------------------------------------------------------------ */
/*                            CONSTANTS                               */
/* ------------------------------------------------------------------ */
const openai = new OpenAI({ apiKey: process.env.KEY_GPT });
const TZ_OFFSET_ISRAEL = 3 * 60 * 60 * 1000;   // +03:00 in ms
const CHECK_INTERVAL   = 60 * 1000;            // 1 min

/* ------------------------------------------------------------------ */
/*                       HELPER / UTILITY FUNCS                       */
/* ------------------------------------------------------------------ */

/**
 * טוען מ-Firestore את אוסף users ומחזיר Map {chatId → creds}
 * @returns {Promise<Record<string,{idInstance:string,token:string}>>}
 */
async function loadUserMap() {
  const map = {};
  const snap = await db.collection('users').get();
  snap.forEach(doc => {
    const d = doc.data();
    if (!d.phone || !d.idInstance || !d.token) return;

    const clean = d.phone.replace(/^0/, '972');
    map[`${clean}@c.us`] = { idInstance:d.idInstance, token:d.token };
  });
  console.log('✅ userMap loaded:', Object.keys(map));
  return map;
}

/**
 * שליחת הודעת WhatsApp לפי Green-API creds
 */
async function sendWhatsappMessage(chatId, message, userMap) {
  const user = userMap[chatId];
  if (!user) return console.warn('⚠️ אין מידע על המשתמש:', chatId);

  try {
    await axios.post(
      `https://api.green-api.com/waInstance${user.idInstance}/sendMessage/${user.token}`,
      { chatId, message }
    );
    console.log('📤 הודעה נשלחה ל:', chatId);
  } catch (err) {
    console.error('❌ שגיאה בשליחה:', err.response?.data || err.message);
  }
}

/**
 * @param {string} reminderDateTime – ISO string
 * @returns {boolean} – האם עבר מועד התזכורת ביחס לזמן ישראל
 */
function isTimeToSend(reminderDateTime) {
  const nowISR = new Date(Date.now() + TZ_OFFSET_ISRAEL);
  return nowISR >= new Date(reminderDateTime);
}

/* ------------------------------------------------------------------ */
/*                       CORE – CHECK REMINDERS                       */
/* ------------------------------------------------------------------ */

/**
 * שורק משימות פתוחות, משגר תזכורות ושם was_sent=true
 */
async function checkReminders() {
  const userMap = await loadUserMap();

  const snap = await db.collection('tasks')
    .where('was_sent','==',false).get();

  if (snap.empty) return console.log('🔕 אין משימות לא מתוזכרות');

  for (const doc of snap.docs) {
    const task   = doc.data();
    const chatId = `${task.phone_number}@c.us`;

    if (!task.reminder_datetime) {
      console.log('❌ reminder_datetime חסר:', task.task_id);
      continue;
    }
    if (!isTimeToSend(task.reminder_datetime)) {
      console.log('⏱ עדיין לא הזמן למשימה', task.task_id);
      continue;
    }

    /* ---------- הכנה לטקסט תזכורת “חכם” ---------- */
    const catId  = task.categoryId || 'general';
    const catDoc = await db.collection('categories').doc(catId).get();
    const { display = catId, emoji = '' } = catDoc.data() || {};

    const gptPrompt = `
המשימה: "${task.task_name}"
הקטגוריה: "${display}"
התאריך: ${task.due_date}

כתוב תזכורת קצרה ונעימה בעברית, כולל אימוג'י אחד מתאים.
`.trim();

    const completion = await openai.chat.completions.create({
      model   : 'gpt-4o-mini',
      messages: [{ role:'user', content:gptPrompt }]
    });

    const message = completion.choices[0]?.message?.content
                 || `⏰ תזכורת: ${task.task_name} (${display}) ${emoji}`;

    await sendWhatsappMessage(chatId, message, userMap);
    await doc.ref.update({ was_sent:true });
    console.log('✅ תזכורת נשלחה →', task.task_id);
  }
}

/* ------------------------------------------------------------------ */
/*                         SCHEDULER (every 1 min)                    */
/* ------------------------------------------------------------------ */
setInterval(checkReminders, CHECK_INTERVAL);
