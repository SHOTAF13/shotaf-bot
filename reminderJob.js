import dotenv from 'dotenv';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import axios from 'axios';
import fs from 'fs';

dotenv.config();

const GREEN_API_ID = process.env.idInstance;
const GREEN_API_TOKEN = process.env.apiTokenInstance;
const credentials = JSON.parse(fs.readFileSync('/etc/secrets/credentials.json', 'utf-8'));
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);

async function sendWhatsappMessage(phone, message) {
  try {
    const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
    await axios.post(`https://api.green-api.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`, {
      chatId,
      message
    });
    console.log("📤 הודעה נשלחה ל-", chatId);
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

    const nowUTC = new Date();
    const now = new Date(nowUTC.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));

    for (const row of rows) {
      const reminderTime = new Date(row.reminder_datetime);

      if (!row.reminder_datetime || row.was_sent === 'TRUE') {
        continue;
      }

      if (reminderTime <= now) {
        const message = `🔔 תזכורת:
${row.original_text || 'משימה ללא תוכן'}`;
        console.log(`📨 שולח תזכורת ל-${row.phone_number} | תוכן: ${message}`);

        await sendWhatsappMessage(row.phone_number, message);

        row.was_sent = true;
        await row.save();
        console.log(`✅ עודכן שורה - סומן שנשלחה (${row.phone_number})`);
      } else {
        console.log(`⏳ עדיין לא הגיע הזמן. תזכורת ב: ${reminderTime.toISOString()} | עכשיו: ${now.toISOString()}`);
      }
    }
  } catch (err) {
    console.error("❌ שגיאה כללית בלולאת התזכורות:", err);
  }
}

setInterval(checkReminders, 60 * 1000);