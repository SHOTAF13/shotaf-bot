import { db } from './firebase.js';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();
console.log("📦 userMap keys:", Object.keys(userMap));

async function loadUsersFromFirestore() {
  const snapshot = await db.collection('users').get();
  const userMap = {};

  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.phone && data.idInstance && data.token) {
      const cleanPhone = data.phone.replace(/^0/, '972');
      const chatId = `${cleanPhone}@c.us`;
      userMap[chatId] = {
        idInstance: data.idInstance,
        token: data.token
      };
    }
  });

  console.log("📦 נטענו משתמשים מ־Firestore (reminder):", Object.keys(userMap));
  return userMap;
}

async function sendWhatsappMessage(chatId, message, userMap) {
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

import { DateTime } from 'luxon';

function isTimeToSend(reminderDateTime) {
  const now = new Date(Date.now() + (3 * 60 * 60 * 1000)); // מוסיף 3 שעות – עכשיו לפי ישראל
  

  const nowStr = now.toISOString().slice(0, 16).replace('T', ' ');
  const reminderStr = reminderDateTime.slice(0, 16).replace('T', ' ');

  console.log(`🕒 השוואת זמן (UTC+3): עכשיו ${nowStr} מול יעד ${reminderStr}`);
  return nowStr === reminderStr;
}



async function checkReminders() {
  const userMap = await loadUsersFromFirestore();
  const snapshot = await db.collection('tasks')
    .where('was_sent', '==', false)
    .get();

  console.log(`🔍 נמצאו ${snapshot.size} משימות ממתינות`);

  for (const doc of snapshot.docs) {
    const task = doc.data();
    const chatId = `${task.phone_number}@c.us`;

    console.log('📋 בודק משימה:', doc.id);
    console.log('📅 reminder_datetime:', task.reminder_datetime);

    if (!task.reminder_datetime) continue;
    if (!isTimeToSend(task.reminder_datetime)) {
      console.log('⏱ עדיין לא הזמן לשלוח את התזכורת הזו');
      continue;
    }

    const message = `⏰ תזכורת: ${task.task_name || 'משימה'} בקטגוריית ${task.category || 'כללי'} ליום ${task.due_date}`;
    console.log(`📨 שולח תזכורת ל־${chatId}: ${message}`);
    await sendWhatsappMessage(chatId, message, userMap);

    await db.collection('tasks').doc(task.task_id).update({ was_sent: true });
    console.log('✅ נשלחה תזכורת ונעודכן was_sent');
  }
}

setInterval(checkReminders, 60 * 1000); // בדיקה כל דקה
