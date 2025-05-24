require('dotenv').config();
const { analyzeMessageWithGPT } = require("./gpt");
const express = require('express');
const bodyParser = require('body-parser');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;

console.log('🔍 GOOGLE_SHEET_ID:', process.env.GOOGLE_SHEET_ID);

function extractReminderTime(text) {
  const lowerText = text.toLowerCase();
  if (lowerText.includes("בבוקר")) return "09:00:00";
  if (lowerText.includes("בצהריים") || lowerText.includes("בצהרים") || lowerText.includes("צהריים")) return "12:00:00";
  if (lowerText.includes("בערב")) return "19:00:00";
  return "12:00:00";
}

async function saveToSheet(taskData) {
  console.log('📥 נכנסנו לפונקציה saveToSheet');
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
  await doc.useServiceAccountAuth(require('/etc/secrets/credentials.json'));
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  await sheet.addRow(taskData);
}

async function sendWhatsappMessage(phone, message) {
  try {
    await axios.post(`https://api.green-api.com/waInstance${process.env.idInstance}/sendMessage/${process.env.apiTokenInstance}`, {
      chatId: phone.replace('+', '') + '@c.us',
      message
    });
    console.log(`📤 הודעה נשלחה ל-${phone}`);
  } catch (err) {
    console.error('❌ שגיאה בשליחת ההודעה:', err.response?.data || err.message);
  }
}

app.post('/webhook', async (req, res) => {
  console.log('📩 התקבלה הודעה חדשה!');
  console.log('📨 גוף ההודעה שהתקבל:', req.body);
  console.log('📨 BODY:', JSON.stringify(req.body, null, 2));

const message = req.body.messageData?.textMessageData?.textMessage || '';
const phone = req.body.senderData?.chatId?.replace('@c.us', '') || 'לא ידוע';


  const row = {
    task_id: 'tsk_' + Date.now(),
    user_id: 'usr_' + phone.slice(-6),
    phone_number: phone,
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

  const gptData = await analyzeMessageWithGPT(message);
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
    row.reminder_datetime = '';
  }

  console.log('🤖 תוצאה מ-GPT:', gptData);
  console.log('📋 שורה מעודכנת עם GPT + תזכורת:', row);

  const responseMessage = `
קיבלתי! ✅
שם פעולה: ${row.task_name || 'לא זוהה'}
קטגוריה: ${row.category || 'לא זוהתה'}
תאריך יעד: ${row.due_date || 'לא צוין'}
תדירות: ${row.frequency || 'חד־פעמי'}
  `.trim();

  try {
    await saveToSheet(row);
    await sendWhatsappMessage(phone, responseMessage);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ שגיאה בשמירה או שליחה:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 שרת פעיל על פורט ${PORT}`);
});
