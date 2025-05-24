require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const axios = require('axios');

const GREEN_API_ID = process.env.GREEN_API_ID;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);

// פונקציה ששולחת הודעת וואטסאפ דרך Green API
async function sendWhatsappMessage(phone, message) {
  try {
    await axios.post(`https://api.green-api.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`, {
      chatId: phone.replace('+', '') + "@c.us",
      message: message
    });
    console.log("📤 הודעה נשלחה ל-", phone);
  } catch (err) {
    console.error("❌ שגיאה בשליחת הודעה:", err.response?.data || err.message);
  }
}

// ⏰ פונקציה שמריצה בדיקה כל דקה
async function checkReminders() {
  try {
    await doc.useServiceAccountAuth(require('/etc/secrets/credentials.json'));
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    const now = new Date();

    for (const row of rows) {
      if (!row.reminder_datetime || row.was_sent === 'TRUE') continue;

      const reminderTime = new Date(row.reminder_datetime);
      if (reminderTime <= now) {
        const message = `🔔 תזכורת: ${row.task_name || 'משימה ללא שם'} \n📅 תאריך: ${row.due_date || 'לא צוין'} \n📁 קטגוריה: ${row.category || 'כללי'}`;

        await sendWhatsappMessage(row.phone_number, message);

        row.was_sent = true;
        await row.save();
        console.log(`📥 עודכן שורה עם תזכורת ל-${row.phone_number}`);
      }
    }
  } catch (err) {
    console.error("❌ שגיאה כללית בלולאת התזכורות:", err);
  }
}

// הרצת הבדיקה כל דקה
setInterval(checkReminders, 60 * 1000);
