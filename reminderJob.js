require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);

// ⏰ פונקציה שמריצה בדיקה כל דקה
async function checkReminders() {
  await doc.useServiceAccountAuth(require('/etc/secrets/credentials.json'));
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();

  const now = new Date();

  for (const row of rows) {
    if (!row.reminder_datetime || row.was_sent === 'TRUE') continue;

    const reminderTime = new Date(row.reminder_datetime);
    if (reminderTime <= now) {
      // שולחים את התזכורת
      const message = `🔔 תזכורת: ${row.task_name || 'משימה ללא שם'} \n📅 תאריך: ${row.due_date || 'לא צוין'} \n📁 קטגוריה: ${row.category || 'כללי'}`;

      await client.messages.create({
        from: 'whatsapp:+14155238886', // המספר של Twilio
        to: row.phone_number,
        body: message,
      });

      row.was_sent = true;
      await row.save();
      console.log(`📤 נשלחה תזכורת ל-${row.phone_number}`);
    }
  }
}

setInterval(checkReminders, 60 * 1000); // כל דקה
