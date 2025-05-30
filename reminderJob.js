import dotenv from 'dotenv';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import axios from 'axios';
import fs from 'fs';

dotenv.config();

// 📌 טען פרטי התחברות ליוזרים שונים
const USERS = [
  {
    id: 'USER1',
    phoneId: process.env.USER1_PHONE_ID,
    idInstance: process.env.USER1_ID_INSTANCE,
    apiToken: process.env.USER1_API_TOKEN
  },
  {
    id: 'USER2',
    phoneId: process.env.USER2_PHONE_ID,
    idInstance: process.env.USER2_ID_INSTANCE,
    apiToken: process.env.USER2_API_TOKEN
  }
];

const credentials = JSON.parse(fs.readFileSync('/etc/secrets/credentials.json', 'utf-8'));
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);

async function sendWhatsappMessage(user, phone, message) {
  try {
    const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
    await axios.post(`https://api.green-api.com/waInstance${user.idInstance}/sendMessage/${user.apiToken}`, {
      chatId,
      message
    });
    console.log(`📤 הודעה נשלחה ל-${chatId} ע"י ${user.id}`);
  } catch (err) {
    console.error("❌ שגיאה בשליחת הודעה:", err.response?.data || err.message);
  }
}

async function checkReminders() {
  try {
    await doc.useServiceAccountAuth(credentials);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    const now = new Date();
    console.log(`🕒 התחלת לולאת בדיקה - זמן נוכחי: ${now.toISOString()}`);

    for (const row of rows) {
      if (!row.reminder_datetime || row.was_sent === 'TRUE') continue;

      const reminderTime = new Date(row.reminder_datetime);
      if (reminderTime <= now) {
        const targetPhone = row.phone_number;

        const user = USERS.find(u => u.phoneId === `${targetPhone}@c.us`);
        if (!user) {
          console.log(`⛔️ אין יוזר מתאים ל-${targetPhone}`);
          continue;
        }

        const message = `🔔 תזכורת:\n${row.original_text || 'משימה ללא תוכן'}`;
        await sendWhatsappMessage(user, targetPhone, message);

        row.was_sent = true;
        await row.save();
        console.log(`✅ נשלחה תזכורת ל-${targetPhone} וסומן כנשלח.`);
      } else {
        console.log(`⏳ עדיין לא הגיע הזמן (${row.reminder_datetime})`);
      }
    }
  } catch (err) {
    console.error("❌ שגיאה בלולאת תזכורות:", err);
  }
}

// 🔁 הפעל כל דקה
setInterval(checkReminders, 60 * 1000);