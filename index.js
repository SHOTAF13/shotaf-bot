/* ------------------------------------------------------------------
   IMPORTS
------------------------------------------------------------------ */
import express       from 'express';
import bodyParser    from 'body-parser';
import dotenv        from 'dotenv';
import axios         from 'axios';
import fs            from 'node:fs/promises';
import path          from 'node:path';
import { Storage }   from '@google-cloud/storage';

import { db }        from './firebase.js';
import {
  analyzeMessageWithGPT,
  loadUserMemory,
  openai,
  modifyTaskSchema,
}                    from './gpt.js';

import {
  updateUserMemory,
  learnFromMessage,
}                    from './updateUserMemory.js';

import {
  ensureCategory,   // FIXME: ודא שהפונקציה קיימת ב-normalize.js
  ensurePerson,     // FIXME: idem
}                    from './normalize.js';

/* ------------------------------------------------------------------
   CONFIG
------------------------------------------------------------------ */
dotenv.config();
const PORT             = process.env.PORT || 10_000;
const BOT_ID_INSTANCE  = process.env.BOT_ID_INSTANCE;
const BOT_TOKEN        = process.env.BOT_TOKEN;
const storage          = new Storage().bucket(process.env.GCLOUD_BUCKET);

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

/* ------------------------------------------------------------------
   RUNTIME-LEVEL STATE
------------------------------------------------------------------ */
const allowedUsers = new Set();

/* ------------------------------------------------------------------
   HELPERS
------------------------------------------------------------------ */
function formatDueDate(iso) {
  if (!iso) return 'לא צוין';
  return new Date(iso)
    .toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
}

function formatFriendlyReminder(iso) {
  if (!iso) return 'לא נקבעה';
  const nowISR = Date.now() + 3 * 60 * 60 * 1000;
  const diff   = (new Date(iso).getTime() - nowISR) / 86_400_000; // ימים
  return new Date(iso).toLocaleString('he-IL',
    diff <= 7
      ? { weekday: 'long', hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit',  month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function sendWhatsappMessage(phone, text) {
  const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
  try {
    await axios.post(
      `https://api.green-api.com/waInstance${BOT_ID_INSTANCE}/sendMessage/${BOT_TOKEN}`,
      { chatId, message: text }
    );
    console.log('📤 >', chatId, ':', text.replace(/\n/g, ' '));
  } catch (err) {
    console.error('❌ sendWhatsappMessage:', err.response?.data || err.message);
  }
}

/* ------------------- Firestore convenience ------------------- */
async function ensureUserExists(phoneDigits) {
  const userId = 'usr_' + phoneDigits.slice(-6);
  const ref    = db.collection('users').doc(userId);
  const snap   = await ref.get();
  if (!snap.exists) {
    await ref.set({
      user_id: userId,
      phone  : phoneDigits,
      created_at: new Date().toISOString(),
    });
    console.log('👤 added user', phoneDigits);
  }
  allowedUsers.add(phoneDigits);
}

async function getLastTask(userId) {
  const snap = await db
    .collection(`tasks/${userId}/user_tasks`)
    .orderBy('created_at', 'desc')
    .limit(1).get();

  if (snap.empty) return null;
  const d = snap.docs[0];
  return { ...d.data(), task_id: d.id };
}

async function updateTaskInFirestore(userId, taskId, changes) {
  return db.doc(`tasks/${userId}/user_tasks/${taskId}`).update(changes);
}

/* ------------------------------------------------------------------
   ONE-OFF BOOTSTRAP – preload allowedUsers
------------------------------------------------------------------ */
(async () => {
  const users = await db.collection('users').get();
  users.forEach(d => {
    const p = (d.data().phone || '').replace(/^0/, '972');
    if (p) allowedUsers.add(p);
  });
  console.log('🟢 allowedUsers loaded:', allowedUsers.size);
})();

/* ------------------------------------------------------------------
   MAIN WEBHOOK
------------------------------------------------------------------ */
app.post('/webhook', async (req, res) => {
  try {
    /* ---------- 0. extract + sanity ---------- */
    const { typeWebhook, senderData, messageData } = req.body;
    if (typeWebhook !== 'incomingMessageReceived') return res.sendStatus(200);

    const chatId  = senderData?.chatId;
    const message = messageData?.textMessageData?.textMessage || '';
    if (!chatId?.endsWith('@c.us') || !message.trim()) return res.sendStatus(200);

    const phone   = chatId.replace('@c.us', '');
    await ensureUserExists(phone);
    if (!allowedUsers.has(phone)) return res.sendStatus(200);

    const userId  = 'usr_' + phone.slice(-6);

    /* ---------- 1. GPT analysis ---------- */
    const gptData = await analyzeMessageWithGPT(message, userId);

    /* ---------- 2. try modify last-task (if close in time) ---------- */
    const lastTask = await getLastTask(userId);
    if (lastTask) {
      const diffMin = (Date.now() - Date.parse(lastTask.created_at)) / 60000;
      if (diffMin <= 5) { // עדכון רק אם <5 דק'
        const payload = {
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content:
                'קיבלת משימה ישנה והודעה חדשה. אם זו הודעה של עדכון, החזר רק את השדות שצריך לעדכן. ' +
                'אם זו משימה חדשה – החזר אובייקט ריק {}.'
            },
            {
              role: 'user',
              content:
                `משימה קודם:\n${JSON.stringify(lastTask, null, 2)}\n\n` +
                `הודעה חדשה:\n${message}`
            }
          ],
          functions: [modifyTaskSchema],
          function_call: { name: 'modify_task' }
        };

        const editRes = await openai.chat.completions.create(payload);
        const fc      = editRes.choices?.[0]?.message?.function_call;
        const changes = fc?.name === 'modify_task'
          ? JSON.parse(fc.arguments || '{}')
          : {};

        if (Object.keys(changes).length) {
          await updateTaskInFirestore(userId, lastTask.task_id, changes);
          await sendWhatsappMessage(phone, '🔁 עודכנתי את המשימה הקודמת ✅');
          return res.sendStatus(200);
        }
      }
    }

    /* ---------- 3. create NOTE ---------- */
    if (gptData.entry_type === 'note') {
      const entry_id = 'ent_' + Date.now();
      await db.collection('entries').doc(entry_id).set({
        entry_id,
        user_id: userId,
        entry_type: 'note',
        title: gptData.note_title,
        body : gptData.note_body,
        created_at: new Date().toISOString()
      });
      await sendWhatsappMessage(phone, `📝 הערה נשמרה!\nכותרת: ${gptData.note_title}`);
      return res.sendStatus(200);
    }

    /* ---------- 4. create TASK ---------- */
    const taskRow = {
      task_id   : 'tsk_' + Date.now(),
      user_id   : userId,
      phone_number : phone,
      original_text: message,
      task_name : gptData.task_name,
      category  : gptData.category || 'כללי',
      categoryId: await ensureCategory(gptData.category), // FIXME
      personId  : await ensurePerson(gptData.person_name, gptData.person_role), // FIXME
      due_date  : gptData.due_date,
      frequency : gptData.frequency,
      reminder_datetime: '',
      was_sent  : false,
      created_at: new Date().toISOString()
    };

    // reminder_datetime
    if (taskRow.due_date && /^\d{4}-\d{2}-\d{2}$/.test(taskRow.due_date)) {
      const [h, m] = (gptData.reminder_time || '12:00').split(':');
      const [Y, M, D] = taskRow.due_date.split('-').map(Number);
      const d = new Date(Date.UTC(Y, M - 1, D, +h, +m));
      if (d < new Date()) d.setUTCDate(d.getUTCDate() + 1);
      taskRow.reminder_datetime = d.toISOString();
    }

    await db
      .collection('tasks').doc(userId)
      .collection('user_tasks')
      .doc(taskRow.task_id).set(taskRow);

    const confirm =
      `💡 סגור! הוספתי לרשימה שלך:\n` +
      `📝 ${taskRow.task_name}\n` +
      `📅 יעד: ${formatDueDate(taskRow.due_date)}\n` +
      `⏰ ${formatFriendlyReminder(taskRow.reminder_datetime)}`;

    await learnFromMessage(userId, gptData);
    await sendWhatsappMessage(phone, confirm);
    return res.sendStatus(200);

  } catch (err) {
    console.error('🔥 /webhook error:', err);
    return res.sendStatus(500);
  }
});

/* ------------------------------------------------------------------
   SIMPLE REMINDER JOB   (מדי דקה)
------------------------------------------------------------------ */
async function checkReminders() {
  try {
    const users = await db.collection('users').get();
    for (const userDoc of users.docs) {
      const userId = userDoc.id;
      const tasks  = await db
        .collection(`tasks/${userId}/user_tasks`)
        .where('was_sent', '==', false).get();

      for (const doc of tasks.docs) {
        const t = doc.data();
        if (!t.reminder_datetime) continue;
        const nowISR = new Date(Date.now() + 3 * 60 * 60 * 1000);
        if (nowISR < new Date(t.reminder_datetime)) continue;

        await sendWhatsappMessage(
          t.phone_number,
          `⏰ תזכורת: ${t.task_name}`
        );
        await doc.ref.update({ was_sent: true });
      }
    }
  } catch (e) {
    console.error('❌ checkReminders', e);
  }
}
setInterval(checkReminders, 60_000);

/* ------------------------------------------------------------------ */
app.listen(PORT, () =>
  console.log(`🚀 Server listening on port ${PORT}`)
);
