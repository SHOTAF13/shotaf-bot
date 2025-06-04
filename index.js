// index.js
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

// טוען משתמשים מה־Firestore
const users = [];
const snapshot = await db.collection('reminder').get();
snapshot.forEach(doc => {
  const data = doc.data();
  users.push({
    phone: data.phone,
    idInstance: data.idInstance,
    token: data.token
  });
});

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

function formatDueDate(isoDate) {
  if (!isoDate) return 'לא צוין';
  const date = new Date(isoDate);
  return date.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
}

function formatFriendlyReminder(isoDate) {
  if (!isoDate) return 'לא נקבעה';
  const now = new Date(Date.now() + (3 * 60 * 60 * 1000));
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
}

async function sendWhatsappMessage(phone, message) {
  const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
  const user = userMap[chatId];
  if (!user) return;

  try {
    await axios.post(`https://api.green-api.com/waInstance${user.idInstance}/sendMessage/${user.token}`, {
      chatId,
      message
    });
    console.log("📤 נשלחה הודעה ל־", chatId);
  } catch (err) {
    console.error("❌ שגיאה בשליחת הודעה:", err.response?.data || err.message);
  }
}

app.post('/webhook', async (req, res) => {
  try {
    const type = req.body.typeWebhook;
    const sender = req.body.senderData?.sender;
    const chatId = req.body.senderData?.chatId;
    const message = req.body.messageData?.textMessageData?.textMessage || '';

    if (!type || !sender || !chatId) return res.sendStatus(200);
    if (!Object.keys(userMap).includes(sender)) return res.sendStatus(200);
    if (sender !== chatId) return res.sendStatus(200);
    if (!message.trim()) return res.sendStatus(200);

    const phone = chatId.replace('@c.us', '');
    const isQuestion = message.trim().endsWith('?');
    const userId = 'usr_' + phone.slice(-6);

    if (isQuestion) {
      const userMemory = await loadUserMemory(userId);
      const answer = await answerUserQuestionWithGPT(message, userMemory, userId);
      await sendWhatsappMessage(phone, answer);
      return res.sendStatus(200);
    }

    let row = {
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
    } catch {}

    row.task_name = gptData.task_name;
    row.category = gptData.category;
    row.due_date = gptData.due_date;
    row.frequency = gptData.frequency;

    if (row.due_date && /^\d{4}-\d{2}-\d{2}$/.test(row.due_date)) {
      const [hour, minute] = gptData.reminder_time.split(':');
      const localDate = new Date(`${row.due_date}T${hour}:${minute}:00`);
      const israelTime = new Date(localDate.getTime() - (3 * 60 * 60 * 1000));
      row.reminder_datetime = israelTime.toISOString().slice(0, 19).replace('T', ' ');
    }

    await db.collection('tasks').doc(row.task_id).set(row);

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
    console.error('🔥 שגיאה כללית ב־/webhook:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 שרת פעיל על פורט ${PORT}`);
});
