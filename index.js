// 📄 index.js – קובץ שמאזין לווטסאפ ומוסיף תזכורות ל־Firestore

import express from 'express';
import bodyParser from 'body-parser';
import { db } from './firebase.js';
import dotenv from 'dotenv';
import axios from 'axios';
import { analyzeMessageWithGPT, answerUserQuestionWithGPT, loadUserMemory } from './gpt.js';

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;

const users = [
  {
    phone: process.env.USER1_PHONE,
    idInstance: process.env.USER1_ID,
    token: process.env.USER1_TOKEN
  },
  {
    phone: process.env.USER2_PHONE,
    idInstance: process.env.USER2_ID,
    token: process.env.USER2_TOKEN
  }
];

const userMap = {};
for (const u of users) {
  if (u.phone) {
    const cleanPhone = u.phone.replace(/^0/, '972');
    const chatId = `${cleanPhone}@c.us`;
    userMap[chatId] = {
      idInstance: u.idInstance,
      token: u.token
    };
  }
}

const formatDueDate = (isoDate) => {
  if (!isoDate) return 'לא צוין';
  const date = new Date(isoDate);
  return date.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
};

const formatFriendlyReminder = (isoDate) => {
  if (!isoDate) return 'לא נקבעה';
  const now = new Date();
  const target = new Date(isoDate);
  const diffInDays = (target - now) / (1000 * 60 * 60 * 24);

  if (diffInDays <= 7) {
    return target.toLocaleString('he-IL', {
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit'
    });
  } else {
    return target.toLocaleString('he-IL', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
};

async function sendWhatsappMessage(phone, message) {
  const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
  const user = userMap[chatId];
  if (!user) return;

  try {
    await axios.post(`https://api.green-api.com/waInstance${user.idInstance}/sendMessage/${user.token}`, {
      chatId,
      message
    });
    console.log("📤 נשלחה תגובה ל־", chatId);
  } catch (err) {
    console.error("❌ שגיאה בשליחת הודעה:", err.response?.data || err.message);
  }
}

app.post('/webhook', async (req, res) => {
  const type = req.body.typeWebhook;
  if (type !== "outgoingMessageReceived") return res.sendStatus(200);

  const sender = req.body.senderData?.sender;
  const chatId = req.body.senderData?.chatId;
  const message = req.body.messageData?.textMessageData?.textMessage || '';

  if (!Object.keys(userMap).includes(sender)) return res.sendStatus(200);
  if (sender !== chatId || !message.trim()) return res.sendStatus(200);

  console.log("📨 הודעה חדשה מזוהה:", { sender, message });

  const phone = chatId.replace('@c.us', '');
  const isQuestion = message.trim().endsWith('?');
  const userId = 'usr_' + phone.slice(-6);

  if (isQuestion) {
    const userMemory = await loadUserMemory(userId);
    const answer = await answerUserQuestionWithGPT(message, userMemory, userId);
    await sendWhatsappMessage(phone, answer);
    return res.sendStatus(200);
  }

  const row = {
    task_id: 'tsk_' + Date.now(),
    user_id: userId,
    phone_number: phone,
    original_text: message,
    task_name: '',
    category: '',
    due_date: '',
    reminder_datetime: '',
    frequency: '',
    was_sent: false,
    created_at: new Date().toISOString(),
  };

  let gptData = {
    task_name: '',
    category: '',
    due_date: '',
    frequency: '',
    reminder_time: '12:00'
  };

  try {
    gptData = await analyzeMessageWithGPT(message);
  } catch {
    console.warn("⚠️ GPT נכשל – מחזיר ערכים ריקים");
  }

  row.task_name = gptData.task_name;
  row.category = gptData.category;
  row.due_date = gptData.due_date;
  row.frequency = gptData.frequency;

  if (row.due_date && /^\d{4}-\d{2}-\d{2}$/.test(row.due_date)) {
    row.reminder_datetime = new Date(`${row.due_date}T${gptData.reminder_time}:00Z`).toISOString();
  }

  try {
    await db.collection('tasks').doc(row.task_id).set(row);
    console.log(`✅ נשמרה משימה חדשה ב־Firestore עבור ${row.phone_number}`);

    const reply = `
💡 סגור! הוספתי את זה לרשימה שלך:

📝 משימה: ${row.task_name || 'לא זוהתה'}
📁 קטגוריה: ${row.category || 'כללי'}
📅 יעד: ${formatDueDate(row.due_date)}
🔁 תדירות: ${row.frequency || 'חד פעמי'}
⏰ תזכורת: ${formatFriendlyReminder(row.reminder_datetime)}
`.trim();

    await sendWhatsappMessage(phone, reply);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ שגיאה בשמירה או בשליחה:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 שרת פעיל על פורט ${PORT}`);
});
