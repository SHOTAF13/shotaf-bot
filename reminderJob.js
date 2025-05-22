require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const twilio = require('twilio');

const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const client = twilio(TWILIO_SID, TWILIO_AUTH);

async function sendReminders() {
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
  await doc.useServiceAccountAuth(require('/etc/secrets/credentials.json'));
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();

  const now = new Date();
  const nowISO = now.toISOString();

  for (let row of rows) {
    if (row.was_sent === 'FALSE' && row.reminder_datetime && row.reminder_datetime <= nowISO) {
      const message = `⏰ תזכורת: ${row.task_name || 'יש לך משימה'} – הגיע הזמן לטפל בזה!`;

      await client.messages.create({
        from: `whatsapp:${TWILIO_NUMBER}`,
        to: row.phone_number,
        body: message,
      });

      row.was_sent = 'TRUE';
      await row.save();
      console.log(`📤 נשלחה תזכורת ל: ${row.phone_number}`);
    }
  }
}

sendReminders();
