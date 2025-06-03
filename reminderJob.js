// 📄 reminderJob.js – קובץ שמריץ תזכורות בזמן ומודיע בוואטסאפ

import { db } from './firebase.js';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

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

async function sendWhatsappMessage(chatId, message) {
  const user = userMap[chatId];
  if (!user) return;

  try {
    await axios.post(`https://api.green-api.com/waInstance${user.idInstance}/sendMessage/${user.token}`, {
      chatId,
      message
    });
    console.log('📤 הודעה נשלחה ל:', chatId);
  } catch (err) {
    console.error('❌ שגיאה בשליחת הודעה:', err.response?.data || err.message);
  }
}

function isTimeToSend(reminderDateTime) {
  const now = new Date();
  const target = new Date(reminderDateTime);
  const diff = Math.abs(now.getTime() - target.getTime());
  return diff <= 1000 * 60; // בטווח של דקה
}

async function checkReminders() {
  const snapshot = await db.collection('tasks')
    .where('was_sent', '==', false)
    .get();

  for (const doc of snapshot.docs) {
    const task = doc.data();
    const chatId = `${task.phone_number}@c.us`;

    if (!task.reminder_datetime) continue;
    if (!isTimeToSend(task.reminder_datetime)) continue;

    const message = `⏰ תזכורת: ${task.task_name || 'משימה'} בקטגוריית ${task.category || 'כללי'} ליום ${task.due_date}`;
    await sendWhatsappMessage(chatId, message);

    await db.collection('tasks').doc(task.task_id).update({ was_sent: true });
    console.log('✅ נשלחה תזכורת ונעודכן was_sent');
  }
}

setInterval(checkReminders, 60 * 1000); // כל דקה