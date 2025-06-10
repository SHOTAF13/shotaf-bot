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
    console.log(`    ⏰ nowISR=${nowISR.toISOString()}, remind=${remindDate.toISOString()}`);
  
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
  // ▶️ 1) התחלת הפונקציה
  console.log('▶️ התחלת checkReminders()', new Date().toISOString());

  // 2) הבאת כל המשתמשים (מסמכי האב באוסף 'tasks')
  const usersSnap = await db.collection('users').get();
  console.log(`🔢 מצאתי ${usersSnap.docs.length} משתמשים ב־'users'`);

  if (usersSnap.empty) {
    console.log('🔕 אין משתמשים כלל – מסיימים');
    return;
  }

  // 3) עבור כל משתמש – שליפה של תת-האוסף user_tasks שלו
  for (const userDoc of usersSnap.docs) {
    const userId = userDoc.id;
    console.log(`\n👤 בודק משתמש ${userId}`);

    const snap = await db
      .collection(`tasks/${userId}/user_tasks`)
      .where('was_sent', '==', false)
      .get();
    console.log(`  🔢 מצאתי ${snap.docs.length} משימות לא נשלחו עבור ${userId}`);

    if (snap.empty) {
      console.log('  🔕 אין משימות פתוחות למשתמש זה');
      continue;
    }

    // 4) עבור כל משימה ב-user_tasks
    for (const doc of snap.docs) {
      const task = doc.data();
      console.log(`    🗂 משימה ${task.task_id} – reminder_datetime=${task.reminder_datetime}`);

      // 5) בדיקת תאריך תזכורת קיים
      if (!task.reminder_datetime) {
        console.log('      ❌ reminder_datetime חסר – מדלגים');
        continue;
      }

      // 6) בדיקת אם הגיע הזמן
      if (!isTimeToSend(task.reminder_datetime)) {
        console.log('      ⏱ עדיין לא הזמן – מדלגים');
        continue;
      }
      console.log('      ⏰ הגיע הזמן – נכנסים לשליחה');

      // === כאן הקוד המקורי שלך לבניית ההודעה ===

      // 7) ניסיון להרגל קודם
      const mem   = await loadUserMemory(task.user_id);
      const habit = mem?.habits?.[task.task_name];

      let message;
      if (habit) {
        // אם זו משימה שחוזרת בהרגל – טקסט פשוט
        message = `⏰ תזכורת (${habit.freq}): ${task.task_name}`;
      } else {
        // אחרת – בונים prompt ושולחים ל-GPT
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

      // 8) שליחה מותאמת
      const personalized = personalize(message, mem);
      const chatId = `${task.phone_number}@c.us`;
      await sendWhatsappMessage(chatId, personalized);
      console.log('      ✅ הודעה נשלחה →', chatId);

      // 9) גלגול קדימה או סימון כנשלח
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
      console.log('      🔄 עדכון משימה ב-Firestore →', updateData);
    }
  }

  console.log('\n▶️ סיום checkReminders()', new Date().toISOString());
}

/* ------------------------------------------------------------------ */
/*                         SCHEDULER (every 1 min)                    */
/* ------------------------------------------------------------------ */
setInterval(checkReminders, CHECK_INTERVAL);

