import express from 'express';
import bodyParser from 'body-parser';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { analyzeMessageWithGPT } from './gpt.js';
import dotenv from 'dotenv';
import credentials from '/etc/secrets/credentials.json' assert { type: 'json' };

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;
console.log('🔍 GOOGLE_SHEET_ID:', process.env.GOOGLE_SHEET_ID);

// שמירת משימה בגוגל שיט
async function saveToSheet(taskData) {
  console.log('📥 נכנסנו לפונקציה saveToSheet');
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
  await doc.useServiceAccountAuth(credentials);
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  await sheet.addRow(taskData);
}

// אין מגבלת לוגים - כל הודעה תודפס
app.post('/webhook', async (req, res) => {
  const sender = req.body.senderData?.sender?.replace('@c.us', '') || '';
  const chatId = req.body.senderData?.chatId?.replace(/(@c\.us|@g\.us)/, '') || '';
  const isGroup = req.body.senderData?.chatId?.endsWith('@g.us');
  const isHistorical = req.body.typeWebhook !== 'incomingMessageReceived';
  const message = req.body.messageData?.textMessageData?.textMessage || '';

  console.log('🟢 הודעה חדשה:');
  console.log(`👤 שולח: ${sender}`);
  console.log(`💬 תוכן: ${message}`);
  console.log(`👥 קבוצה: ${isGroup}`);
  console.log(`⏳ היסטורית: ${isHistorical}`);
  console.log(`📦 body:`, JSON.stringify(req.body, null, 2));

  // השורה לשמירה בגוגל שיט
  const row = {
    task_id: 'tsk_' + Date.now(),
    user_id: 'usr_' + chatId.slice(-6),
    phone_number: chatId,
    original_text: message,
    task_name: '',
    category: '',
    due_date: '',
    frequency: '',
    reminder_datetime: '',
    was_sent: false,
    created_at: new Date().toISOString(),
  };

  console.log('🗃️ שורה שנבנתה מהודעה:', row);

  // 🔕 ניתוח GPT + שליחת תגובה - בהערה בשלב זה
  /*
  let gptData = { task_name: '', category: '', due_date: '', frequency: '' };
  try {
    gptData = await analyzeMessageWithGPT(message);
  } catch (e) {
    console.warn("⚠️ GPT נכשל – מחזיר שדות ריקים");
  }

  row.task_name = gptData.task_name || '';
  row.category = gptData.category || '';
  row.due_date = gptData.due_date || '';
  row.frequency = gptData.frequency || '';

  let reminderHour = '12:00';
  if (message.includes('בבוקר')) reminderHour = '09:00';
  else if (message.includes('בערב')) reminderHour = '19:00';

  if (row.due_date && /^\d{4}-\d{2}-\d{2}$/.test(row.due_date)) {
    const time = reminderHour + ':00';
    row.reminder_datetime = new Date(`${row.due_date}T${time}Z`).toISOString();
  } else {
    console.warn("⚠️ אין תאריך תקני – reminder_datetime נשאר ריק");
  }

  console.log('🤖 תוצאה מ-GPT:', gptData);
  console.log('📋 שורה מעודכנת עם GPT + תזכורת:', row);

  try {
    await saveToSheet(row);
  } catch (err) {
    console.error('❌ שגיאה בשמירה:', err);
  }
  */

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 שרת פעיל על פורט ${PORT}`);
});
