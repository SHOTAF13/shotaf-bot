/* ------------------------------------------------------------------ */
/*                               IMPORTS                              */
/* ------------------------------------------------------------------ */
import dotenv            from 'dotenv';
import axios             from 'axios';
import { db }            from './firebase.js';
import { loadUserMemory } from './gpt.js';
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

/**
 * שליחת הודעת WhatsApp לפי Green-API creds
 */
async function sendWhatsappMessage(chatId, message) {
  const BASE_URL = `https://7105.api.greenapi.com`;

  try {
    await axios.post(
      `${BASE_URL}/waInstance${process.env.BOT_ID_INSTANCE}/sendMessage/${process.env.BOT_TOKEN}`,
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

function personalize(msg, mem){
  switch (mem?.profile?.tone){
    case 'דוחף': return msg + '\nיאללה, קפוץ על זה!';
    case 'חברי': return msg.replace('⏰','🤗');
    default:     return msg;
  }
}


/* ------------------------------------------------------------------ */
/*                       CORE – CHECK REMINDERS                       */
/* ------------------------------------------------------------------ */

/**
 * סורק משימות פתוחות, שולח תזכורות “חכמות”,
 * ומעדכן was_sent או reminder_datetime לפי תדירות (frequency).
 *
 * frequency:
 *   • ""   | "חד פעמי"        → was_sent = true
 *   • "יומי"                  → reminder +1d
 *   • "שבועי" | "כל יום ראשון"→ reminder +7d
 *   • "חודשי"                 → reminder +1m (שומר על יום בחודש)
 */
async function checkReminders() {


  const snap = await db.collection('tasks')
    .where('was_sent','==',false).get();

  if (snap.empty) return console.log('🔕 אין משימות לא מתוזכרות');

  for (const doc of snap.docs) {
    const task   = doc.data();
    const chatId = `${task.phone_number}@c.us`;

    if (!task.reminder_datetime){
      console.log('❌ reminder_datetime חסר:', task.task_id);
      continue;
    }
    if (!isTimeToSend(task.reminder_datetime)){
      console.log('⏱ עדיין לא הזמן למשימה', task.task_id);
      continue;
    }
/* ---------- נסה קודם הרגל קבוע ---------- */
const mem   = await loadUserMemory(task.user_id);
const habit = mem?.habits?.[task.task_name];

// 2) בונים את ההודעה — אם יש הרגל, משתמשים בו, אחרת מבקשים מ-GPT
let message;
if (habit) {
  message = `⏰ תזכורת (${habit.freq}): ${task.task_name}`;
} else {
  /* ---------- בניית הודעה חכמה באמצעות GPT ---------- */
  const catId  = task.categoryId || 'general';
  const catDoc = await db.collection('categories').doc(catId).get();
  const { display = catId, emoji = '' } = catDoc.data() || {};

  const gptPrompt = `
המשימה: "${task.task_name}"
הקטגוריה: "${display}"
התאריך: ${task.due_date}

כתוב תזכורת קצרה ונעימה בעברית.
`.trim();

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role:'user', content: gptPrompt }]
  });

  message = completion.choices[0]?.message?.content
            || `⏰ תזכורת: ${task.task_name} (${display}) ${emoji}`;
}

// 3) שליחה (לכל סוג הודעה)
const personalized = personalize(message, mem);
await sendWhatsappMessage(chatId, personalized);

// 4) גלגול קדימה / סימון כנשלח
const updateData = {};
const freq = (task.frequency || '').trim();

switch (freq) {
  case 'יומי':
    updateData.reminder_datetime = new Date(
      new Date(task.reminder_datetime).getTime() + 24*60*60*1000
    ).toISOString();
    break;

  case 'שבועי':
  case 'כל יום ראשון':
    updateData.reminder_datetime = new Date(
      new Date(task.reminder_datetime).getTime() + 7*24*60*60*1000
    ).toISOString();
    break;

  case 'חודשי': {
    const d = new Date(task.reminder_datetime);
    d.setMonth(d.getMonth() + 1);
    updateData.reminder_datetime = d.toISOString();
    break;
  }

  default: // חד-פעמי או ריק
    updateData.was_sent = true;
}

  await doc.ref.update(updateData);
  console.log('✅ תזכורת נשלחה →', task.task_id);


}
/* ------------------------------------------------------------------ */
/*                         SCHEDULER (every 1 min)                    */
/* ------------------------------------------------------------------ */
setInterval(checkReminders, CHECK_INTERVAL);
}