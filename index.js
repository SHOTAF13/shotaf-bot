// index.js — גרסה מותאמת לפיילוט אישי בלבד
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

async function saveToSheet(taskData) {
  console.log('📥 נכנסנו לפונקציה saveToSheet');
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
  await doc.useServiceAccountAuth(require('/etc/secrets/credentials.json'));
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  await sheet.addRow(taskData);
}

// הודעות יוצאות - מבוטל זמנית
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
  const sender = req.body.senderData?.sender?.replace('@c.us', '') || '';
  const chatId = req.body.senderData?.chatId?.replace('@c.us', '') || '';

  // התנאי: רק אם אתה שולח לעצמך
  if (sender !== process.env.MY_PHONE || chatId !== process.env.MY_PHONE) {
    return res.sendStatus(200);
  }

  console.log('📩 התקבלה הודעה שאני שלחתי לעצמי!');
  console.log('📨 BODY:', JSON.stringify(req.body, null, 2));

  const message = req.body.messageData?.textMessageData?.textMessage || '';

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

  try {
    const gptData = await analyzeMessageWithGPT(message);
    row.task_name = gptData.task_name || '';
    row.category = gptData.category || '';
    row.due_date = gptData.due_date || '';
    row.frequency = gptData.frequency || '';

    let reminderHour = '12:00';
    if (message.includes('בבוקר')) reminderHour = '09:00';
    else if (message.includes('בערב')) reminderHour = '19:00';

    if (row.due_date && /^\d{4}-\d{2}-\d{2}$/.test(row.due_date)) {
      row.reminder_datetime = new Date(`${row.due_date}T${reminderHour}:00Z`).toISOString();
    } else {
      console.warn("⚠️ אין תאריך תקני – reminder_datetime נשאר ריק");
      row.reminder_datetime = '';
    }

    console.log('🤖 תוצאה מ-GPT:', gptData);
    console.log('📋 שורה מעודכנת עם GPT + תזכורת:', row);

    await saveToSheet(row);

    /*
    const responseMessage = `
    קיבלתי! ✅
    שם פעולה: ${row.task_name || 'לא זוהה'}
    קטגוריה: ${row.category || 'לא זוהתה'}
    תאריך יעד: ${row.due_date || 'לא צוין'}
    תדירות: ${row.frequency || 'חד־פעמי'}
    `.trim();

    await sendWhatsappMessage(chatId, responseMessage);
    */

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ שגיאה בתהליך:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 שרת פעיל על פורט ${PORT}`);
});