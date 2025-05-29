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
const GREEN_API_ID = process.env.idInstance;
const GREEN_API_TOKEN = process.env.apiTokenInstance;
const credentials = JSON.parse(fs.readFileSync('/etc/secrets/credentials.json', 'utf-8'));

// נרמול מספר טלפון ממך לעצמך
const rawPhone = process.env.MY_PHONE || '';
const MY_PHONE_CLEAN = rawPhone.replace(/^0/, '').replace(/^972/, '');
const MY_PHONE_ID = `972${MY_PHONE_CLEAN}@c.us`;

// שליחת הודעת וואטסאפ
async function sendWhatsappMessage(phone, message) {
  try {
    const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
    await axios.post(`https://api.green-api.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`, {
      chatId,
      message
    });
    console.log("📤 נשלחה תגובה למשתמש:", message);
  } catch (err) {
    console.error("❌ שגיאה בשליחת הודעה:", err.response?.data || err.message);
  }
}

// שמירה ל־Google Sheets
async function saveToSheet(taskData) {
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
  await doc.useServiceAccountAuth(credentials);
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  await sheet.addRow(taskData);
}

app.post('/webhook', async (req, res) => {
  console.log('📨 קיבלתי הודעה מה-Webhook:');
  console.log(JSON.stringify(req.body, null, 2));

  const type = req.body.typeWebhook;

  // סינון ראשוני לפי סוג ההודעה
  if (type !== "outgoingMessageReceived") {
    console.log("⛔️ לא outgoingMessageReceived – מתעלם");
    return res.sendStatus(200);
  }

  const sender = req.body.senderData?.sender;
  const chatId = req.body.senderData?.chatId;
  const message = req.body.messageData?.textMessageData?.textMessage || '';

  const isFromSelfToSelf = sender === MY_PHONE_ID && chatId === MY_PHONE_ID;

  console.log("💬 sender:", sender);
  console.log("💬 chatId:", chatId);
  console.log("📱 MY_PHONE_ID:", MY_PHONE_ID);
  console.log("💬 message:", message);

  if (!isFromSelfToSelf || !message.trim()) {
    console.log("⛔️ לא הודעה ממני לעצמי או הודעה ריקה – מדלג");
    return res.sendStatus(200);
  }

  console.log('✅ הודעה מזוהה כמשימה ממני לעצמי – ממשיך לעיבוד...');

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

  let gptData = {
    task_name: '',
    category: '',
    due_date: '',
    frequency: '',
    reminder_time: '12:00'
  };

  try {
    gptData = await analyzeMessageWithGPT(message);
  } catch (err) {
    console.warn("⚠️ GPT נכשל – מחזיר ערכים ריקים");
  }

  row.task_name = gptData.task_name;
  row.category = gptData.category;
  row.due_date = gptData.due_date;
  row.frequency = gptData.frequency;

  if (row.due_date && /^\\d{4}-\\d{2}-\\d{2}$/.test(row.due_date)) {
    row.reminder_datetime = new Date(`${row.due_date}T${gptData.reminder_time}:00Z`).toISOString();
  }

  try {
    await saveToSheet(row);

    const reply = `
💡 קלטתי את המשימה:

📝 משימה: ${row.task_name || 'לא זוהתה'}
📁 קטגוריה: ${row.category || 'כללי'}
📅 תאריך יעד: ${row.due_date || 'לא צוין'}
🔁 תדירות: ${row.frequency || 'חד פעמי'}
⏰ תזכורת תישלח ב־: ${row.reminder_datetime ? new Date(row.reminder_datetime).toLocaleString("he-IL") : 'לא נקבעה'}
`.trim();

    await sendWhatsappMessage(phone, reply);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ שגיאה בשמירה או בשליחה:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 שרת פעיל על פורט ${PORT}`);
});
