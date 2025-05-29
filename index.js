import express from 'express';
import bodyParser from 'body-parser';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { analyzeMessageWithGPT } from './gpt.js';
import dotenv from 'dotenv';
import fs from 'fs';
import axios from 'axios';

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;
console.log('🔍 GOOGLE_SHEET_ID:', process.env.GOOGLE_SHEET_ID);

const credentials = JSON.parse(
  fs.readFileSync('/etc/secrets/credentials.json', 'utf-8')
);

async function sendWhatsappMessage(phone, message) {
  try {
    await axios.post(`https://api.green-api.com/waInstance${process.env.idInstance}/sendMessage/${process.env.apiTokenInstance}`, {
      chatId: phone + "@c.us",
      message: message
    });
    console.log("📤 הודעה נשלחה ל-", phone);
  } catch (err) {
    console.error("❌ שגיאה בשליחת הודעה:", err.response?.data || err.message);
  }
}

async function saveToSheet(taskData) {
  console.log('📥 נכנסנו לפונקציה saveToSheet');
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
  await doc.useServiceAccountAuth(credentials);
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  await sheet.addRow(taskData);
}

app.post('/webhook', async (req, res) => {
  const type = req.body.typeWebhook;
  const sender = req.body.senderData?.sender;
  const chatId = req.body.senderData?.chatId;
  const message = req.body.messageData?.textMessageData?.textMessage || '';

  const isSelfMessage =
    (type === 'outgoingMessageReceived' || type === 'outgoingAPIMessageReceived') &&
    sender === chatId &&
    sender?.includes(process.env.MY_PHONE);

  if (!isSelfMessage) {
    console.log(`📥 התקבלה הודעה שלא מעצמי – מדלג`);
    return res.sendStatus(200);
  }

  console.log('📤 הודעה שאני שלחתי לעצמי!');
  console.log(JSON.stringify(req.body, null, 2));

  const phone = chatId.replace('@c.us', '');

  const row = {
    task_id: 'tsk_' + Date.now(),
    user_id: 'usr_' + phone.slice(-6),
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

  console.log('🗃️ שורה שנבנתה מהודעה:', row);

  let gptData = { task_name: '', category: '', due_date: '', frequency: '' };
  try {
    gptData = await analyzeMessageWithGPT(message);
  } catch {
    console.warn("⚠️ GPT נכשל – מחזיר שדות ריקים");
  }

  row.task_name = gptData.task_name || '';
  row.category = gptData.category || 'כללי';
  row.due_date = gptData.due_date || '';
  row.frequency = gptData.frequency || 'חד פעמי';

  let reminderHour = '12:00';
  if (message.includes('בבוקר')) reminderHour = '09:00';
  else if (message.includes('בערב')) reminderHour = '19:00';

  if (row.due_date && /^\d{4}-\d{2}-\d{2}$/.test(row.due_date)) {
    const time = reminderHour + ':00';
    row.reminder_datetime = new Date(`${row.due_date}T${time}Z`).toISOString();
  } else {
    console.warn("⚠️ אין תאריך תקני – reminder_datetime נשאר ריק");
    row.reminder_datetime = '';
  }

  console.log('🤖 תוצאה מ-GPT:', gptData);
  console.log('📋 שורה מעודכנת עם GPT + תזכורת:', row);

  try {
    await saveToSheet(row);
  } catch (err) {
    console.error('❌ שגיאה בשמירה:', err);
    return res.sendStatus(500);
  }

  const reply = `💡 קלטתי את המשימה:
📝 משימה: ${row.task_name || 'לא זוהתה'}
📁 קטגוריה: ${row.category || 'כללי'}
📅 תאריך יעד: ${row.due_date || 'לא צוין'}
🔁 תדירות: ${row.frequency || 'חד פעמי'}
⏰ תזכורת תישלח ב־: ${row.reminder_datetime ? new Date(row.reminder_datetime).toLocaleString('he-IL') : 'לא נקבעה'}
`;

  await sendWhatsappMessage(phone, reply);
  console.log("📤 נשלחה תגובה למשתמש:", reply);

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 שרת פעיל על פורט ${PORT}`);
});
