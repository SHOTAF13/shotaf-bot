require('dotenv').config();
const { analyzeMessageWithGPT } = require("./gpt");
const express = require('express');
const bodyParser = require('body-parser');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;

console.log('🔍 GOOGLE_SHEET_ID:', process.env.GOOGLE_SHEET_ID);

// פונקציה ששומרת שורה בגוגל שיט
async function saveToSheet(taskData) {
  console.log('📥 נכנסנו לפונקציה saveToSheet');

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);

  console.log('🔵 auth');
  await doc.useServiceAccountAuth(
    require('/etc/secrets/credentials.json') // ⬅️ הנתיב לקובץ הסודי ב־Render
  );

  console.log('🔵 load');
  await doc.loadInfo();

  console.log('🔵 sheet select');
  const sheet = doc.sheetsByIndex[0];

  console.log('🟡 שורה לפני שמירה:', taskData);
  await sheet.addRow(taskData);
}

// טיפול בקבלת הודעת ווטסאפ
app.post('/webhook', async (req, res) => {
  console.log('📩 התקבלה הודעה חדשה!');
  console.log('📨 גוף ההודעה שהתקבל:', req.body);

  const message = req.body.Body || '';
  const phone = req.body.From || 'לא ידוע';

  const row = {
    task_id: 'tsk_' + Date.now(),
    user_id: 'usr_' + phone.slice(-6),
    phone_number: phone,
    original_text: message,
    task_name: '',
    category: '',
    due_date: '',
    frequency: '',
    created_at: new Date().toISOString(),
  };

  console.log('🗃️ שורה שנבנתה מהודעה:', row);

  // ניתוח עם GPT
  const gptData = await analyzeMessageWithGPT(message);
  row.task_name = gptData.task_name;
  row.category = gptData.category;
  row.due_date = gptData.due_date;
  row.frequency = gptData.frequency;

  console.log('🤖 תוצאה מ-GPT:', gptData);
  console.log('📋 שורה מעודכנת עם GPT:', row);

  // הודעה שתישלח ללקוח
  const responseMessage = `
קיבלתי! ✅
שם פעולה: ${row.task_name || 'לא זוהה'}
קטגוריה: ${row.category || 'לא זוהתה'}
תאריך יעד: ${row.due_date || 'לא צוין'}
תדירות: ${row.frequency || 'חד־פעמי'}
  `.trim();

  try {
    await saveToSheet(row);
    console.log('✅ נשמר בהצלחה בגיליון!');
    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Message>${responseMessage}</Message></Response>`);
  } catch (err) {
    console.error('❌ שגיאה בשמירה:', err);
    console.log('📴 שולח תגובה עם שגיאה ללקוח:', phone);
    res.sendStatus(500);
  }
});

// הפעלת השרת
app.listen(PORT, () => {
  console.log(`🚀 שרת פעיל על פורט ${PORT}`);
});
