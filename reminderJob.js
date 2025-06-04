
import { db } from './firebase.js';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

async function loadUserMap() {
  const userMap = {};
  const snapshot = await db.collection('users').get();

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

  console.log("✅ userMap loaded:", Object.keys(userMap));
  return userMap;
}

async function sendWhatsappMessage(chatId, message, userMap) {
  const user = userMap[chatId];
  if (!user) {
    console.warn("⚠️ אין מידע על המשתמש:", chatId);
    return;
  }

  try {
    await axios.post(`https://api.green-api.com/waInstance${user.idInstance}/sendMessage/${user.token}`, {
      chatId,
      message
    });
    console.log("📤 הודעה נשלחה ל:", chatId);
  } catch (err) {
    console.error("❌ שגיאה בשליחה:", err.response?.data || err.message);
  }
}

function isTimeToSend(reminderDateTime) {
  const nowUTC = new Date();
  const nowIsrael = new Date(nowUTC.getTime() + 3 * 60 * 60 * 1000); // +3 שעות ל־Asia/Jerusalem
  const target = new Date(reminderDateTime);
  return nowIsrael.getTime() >= target.getTime();
}

async function checkReminders() {
  const userMap = await loadUserMap();

  const snapshot = await db.collection('tasks')
    .where('was_sent', '==', false)
    .get();

  if (snapshot.empty) {
    console.log("🔕 אין משימות לא מתוזכרות");
    return;
  }

  for (const doc of snapshot.docs) {
    const task = doc.data();
    const chatId = `${task.phone_number}@c.us`;

    console.log("📋 בודק משימה:", task.task_id);
    console.log("📅 reminder_datetime:", task.reminder_datetime);

    if (!task.reminder_datetime) {
      console.log("❌ reminder_datetime חסר במשימה:", task.task_id);
      continue;
    } 

    const shouldSend = isTimeToSend(task.reminder_datetime);

    if (shouldSend) {
    const cat = await db.collection('categories').doc(task.categoryId).get();
    const { display = task.categoryId, emoji = '' } = cat.data() || {};
    const message = `⏰ תזכורת: ${task.task_name} (${display}) ${emoji}  ליום ${task.due_date}`;

      await sendWhatsappMessage(chatId, message, userMap);
      await db.collection('tasks').doc(task.task_id).update({ was_sent: true });
      console.log("✅ תזכורת נשלחה ועדכון was_sent=true");
    } else {
      console.log("⏱ עדיין לא הזמן לשלוח את התזכורת הזו");
    }
  }
}

// מריץ כל דקה
setInterval(checkReminders, 60 * 1000);
