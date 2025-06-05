/* ------------------------------------------------------------------ */
/*                             Imports                                */
/* ------------------------------------------------------------------ */
import express                    from 'express';
import bodyParser                 from 'body-parser';
import dotenv                     from 'dotenv';
import axios                      from 'axios';

import { db }                     from './firebase.js';
import fs                         from 'node:fs/promises';
import path                       from 'node:path';
import {
  analyzeMessageWithGPT,
  answerUserQuestionWithGPT,
  loadUserMemory
}                                 from './gpt.js';
import { updateUserMemory }       from './updateUserMemory.js';
import { ensureCategory, ensurePerson } from './normalize.js';

/* ------------------------------------------------------------------ */
/*                        Global-level constants                      */
/* ------------------------------------------------------------------ */
dotenv.config();
const PORT = process.env.PORT || 10000;
const app  = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended:false }));

/** Map chatId → { idInstance, token } */
const userMap = {};

/* ------------------------------------------------------------------ */
/*                       Helper / formatter fns                       */
/* ------------------------------------------------------------------ */

/**
 * @param {string} isoDate – full ISO string
 * @returns {string}       – DD.MM format in he-IL or 'לא צוין'
 */
function formatDueDate(isoDate) {
  if (!isoDate) return 'לא צוין';
  return new Date(isoDate).toLocaleDateString('he-IL', { day:'2-digit', month:'2-digit' });
}

/**
 * טקסט ידידותי לתזכורת (היום<7 ימים → יום+שעה, אחרת תאריך+שעה)
 */
function formatFriendlyReminder(isoDate) {
  if (!isoDate) return 'לא נקבעה';

  const nowISR = new Date(Date.now()+3*60*60*1000);   // Asia/Jerusalem
  const target = new Date(isoDate);
  const diff   = (target-nowISR)/(1000*60*60*24);

  return target.toLocaleString('he-IL',
    diff<=7
      ? { weekday:'long', hour:'2-digit', minute:'2-digit' }
      : { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }
  );
}
if (process.env.DEBUG_MEDIA === '1') {
  console.dir(req.body, { depth: 4 });
}


/**
 * שולח הודעת WhatsApp למספר (לפי Green-API instance/token במפת המשתמשים)
 */
async function sendWhatsappMessage(phone, message) {
  const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
  const user   = userMap[chatId];
  if (!user) return;

  try {
    await axios.post(`https://api.green-api.com/waInstance${user.idInstance}/sendMessage/${user.token}`, {
      chatId, message
    });
    console.log('📤 נשלחה הודעה ל-', chatId);
  } catch (err) {
    console.error('❌ שגיאה בשליחת הודעה:', err.response?.data || err.message);
  }
}

/* ------------------------------------------------------------------ */
/*              Bootstrapping userMap from Firestore                  */
/* ------------------------------------------------------------------ */
(async () => {
  const snapshot = await db.collection('users').get();
  snapshot.forEach(doc => {
    const d   = doc.data();
    if (!d.phone || !d.idInstance || !d.token) return;

    const raw = d.phone.trim().replace(/[^0-9]/g,'');
    const num = raw.startsWith('0') ? raw.replace(/^0/,'972') : raw;
    userMap[`${num}@c.us`] = { idInstance:d.idInstance, token:d.token };
  });
  console.log('📦 userMap keys:', Object.keys(userMap));
})();



/* ------------------------------------------------------------------ */
/*                        Main webhook route                          */
/* ------------------------------------------------------------------ */

/**
 * Webhook from Green-API.  
 * 1. אם זו שאלה (מסתיימת ב-?) – משיב מהזיכרון.  
 * 2. אחרת:  
 *    • note → יוצר/מעדכן פתק.  
 *    • task → שומר משימה + תזכורת.  
 *    • “מה יש לי השבוע?” → שולח סיכום שבוע.
 */
app.post('/webhook', async (req,res)=>{
  try {
    /* ---------- sanity checks ---------- */
    const { typeWebhook:type, senderData, messageData } = req.body;
    const sender  = senderData?.sender;
    const chatId  = senderData?.chatId;
    const message = messageData?.textMessageData?.textMessage || '';
    if (!type||!sender||!chatId || sender!==chatId || !message.trim()) return res.sendStatus(200);
    if (!userMap[sender]) return res.sendStatus(200);

    /* ---------- A. Media message ---------- */
const typeMsg  = req.body.messageData?.typeMessage;          // image / document / ...
if (typeMsg === 'image' || typeMsg === 'document') {
  const downloadUrl = req.body.messageData?.[`${typeMsg}MessageData`]?.downloadUrl;
  const mime        = req.body.messageData?.[`${typeMsg}MessageData`]?.mimeType;

  // הטקסט הנלווה (caption) – ישמש ככותרת
  const caption = req.body.messageData?.extendedTextMessageData?.text
               || req.body.messageData?.textMessageData?.textMessage
               || 'קובץ ללא שם';
  const tags    = await tagsFromCaption(caption);

  /* 1. שמירה ב-Storage */
  const { url, bucketPath } = await saveMediaToStorage(downloadUrl, mime, userId);

  /* 2. מסמך entries */
  const entry_id = 'ent_' + Date.now();
  await db.collection('entries').doc(entry_id).set({
    entry_id,
    user_id : userId,
    entry_type : 'file',
    title  : caption,
    url,
    bucketPath,
    mime,
    tags   : tags.length ? tags : ['קובץ'],
    created_at : new Date().toISOString()
  });

  /**
 * מוריד קובץ מ-Green-API ומעלה ל-Firebase Storage.
 * @param {string} downloadUrl
 * @param {string} mime
 * @param {string} userId
 * @returns {Promise<{url:string,bucketPath:string,mime:string}>}
 */
async function saveMediaToStorage(downloadUrl, mime, userId){
  const resp = await axios.get(downloadUrl,{ responseType:'arraybuffer' });
  const ext  = mime.split('/')[1] || 'bin';
  const bucketPath = `users/${userId}/${Date.now()}.${ext}`;
  const tmp  = path.join('/tmp', path.basename(bucketPath));

  await fs.writeFile(tmp, resp.data);
  await storage.upload(tmp,{ destination: bucketPath });
  await fs.unlink(tmp);

  const [url] = await storage.file(bucketPath).getSignedUrl({
    action:'read', expires:'2028-01-01'   // 3 שנים
  });
  return { url, bucketPath, mime };
}


  /* 3. זיכרון – מוסיף keyword */
  await updateUserMemory(userId, { keywords:{ [caption]: 'file' } });

  await sendWhatsappMessage(phone, `📎 קובץ נשמר!\nכותרת: ${caption}`);
  return res.sendStatus(200);
}


    /* ---------- basic vars ---------- */
    const phone     = chatId.replace('@c.us','');
    const userId    = 'usr_'+phone.slice(-6);
    const isQuestion= message.trim().endsWith('?');

    /* ---------- 1. Q&A path ---------- */
    if (isQuestion) {
      const memory = await loadUserMemory(userId);
      const answer = await answerUserQuestionWithGPT(message, memory, userId);
      await sendWhatsappMessage(phone, answer);
      return res.sendStatus(200);
    }

    /* ---------- GPT analysis ---------- */
    const gptData = await analyzeMessageWithGPT(message, userId);

    /* ---------- 2. NOTE (new) ---------- */
    if ((gptData.entry_type||'').trim().toLowerCase()==='note') {
      const noteRow = {
        entry_id  : 'ent_'+Date.now(),
        user_id   : userId,
        entry_type: 'note',
        title     : gptData.note_title,
        body      : gptData.note_body,
        created_at: new Date().toISOString()
      };
      await db.collection('entries').doc(noteRow.entry_id).set(noteRow);
      if (noteRow.title) await updateUserMemory(userId, { keywords:{ [noteRow.title ]:'note' } });
      await sendWhatsappMessage(phone, `📝 הערה נשמרה!\nכותרת: ${noteRow.title}`);
      return res.sendStatus(200);
    }

    /* ---------- 3. NOTE-UPDATE ---------- */
    if ((gptData.entry_type||'').trim().toLowerCase()==='note_update') {
      const snap = await db.collection('entries')
        .where('user_id','==',userId)
        .where('title'  ,'==',gptData.note_title)
        .limit(1).get();

      if (snap.empty){
        await sendWhatsappMessage(phone, `לא מצאתי פתק בשם: ${gptData.note_title}`);
        return res.sendStatus(200);
      }
      const ref  = snap.docs[0].ref;
      const body = `${snap.docs[0].data().body}\n${gptData.note_append}`;
      await ref.update({ body, updated_at:new Date().toISOString() });
      await sendWhatsappMessage(phone,'✅ הפתק עודכן!');
      return res.sendStatus(200);
    }

    /* ---------- 4. Weekly summary ---------- */
    const weeklyRegex = /מה.*(יש|רשום).*(השבוע)/i;
    if (weeklyRegex.test(message)) {
      const today = new Date();
      const until = new Date(today); until.setDate(today.getDate()+7);

      const snap = await db.collection('tasks')
        .where('user_id','==',userId)
        .where('due_date','>=', today.toISOString().slice(0,10))
        .where('due_date','<=', until.toISOString().slice(0,10))
        .get();

      if (snap.empty) {
        await sendWhatsappMessage(phone,'אין משימות לשבוע הקרוב 🙌');
        return res.sendStatus(200);
      }

      const list = snap.docs
        .map(d=>d.data())
        .sort((a,b)=>a.due_date.localeCompare(b.due_date))
        .map(t=>`• ${t.due_date} – ${t.task_name}`)
        .join('\n');

      await sendWhatsappMessage(phone,`🗓️ השבוע:\n${list}`);
      return res.sendStatus(200);
    }
    const receiptsRegex = /כל.*הקבלות/i;
if (receiptsRegex.test(message)) {
  const snap = await db.collection('entries')
    .where('user_id','==',userId)
    .where('entry_type','==','file')
    .where('tags','array-contains','קבלה')
    .get();

  if (snap.empty){
    await sendWhatsappMessage(phone,'לא נמצאו קבלות 🤷‍♂️');
    return res.sendStatus(200);
  }
  const list = snap.docs.map(d=>`• ${d.data().title}\n${d.data().url}`).join('\n\n');
  await sendWhatsappMessage(phone,`🧾 הקבלות שלך:\n${list}`);
  return res.sendStatus(200);
}

const allFilesRegex = /כל\s+(.+?)\s*$/;   // לדוגמה: "כל הקבלות", "כל המתכונים"
const match = message.match(allFilesRegex);

if (match && match[1]) {
  const tag = match[1].trim();            // "הקבלות"  / "המתכונים"
  const snap = await db.collection('entries')
    .where('user_id','==',userId)
    .where('entry_type','==','file')
    .where('tags','array-contains', tag)   // תייג בזמן ההעלאה
    .get();

  if (snap.empty){
    await sendWhatsappMessage(phone,`לא נמצאו ${tag}.`);
    return res.sendStatus(200);
  }

  const txt = snap.docs.map(d=>`• ${d.data().title}\n${d.data().url}`).join('\n\n');
  await sendWhatsappMessage(phone,`📁 ${tag}:\n${txt}`);
  return res.sendStatus(200);
}



    /* ---------- 5. TASK (default) ---------- */
    const taskRow = {
      task_id   : 'tsk_'+Date.now(),
      user_id   : userId,
      phone_number: phone,
      original_text: message,
      task_name : gptData.task_name,
      category  : gptData.category,
      categoryId: await ensureCategory(gptData.category),
      personId  : await ensurePerson(gptData.person_name, gptData.person_role),
      due_date  : gptData.due_date,
      frequency : gptData.frequency,
      reminder_datetime:'',
      was_sent  : false,
      created_at: new Date().toISOString()
    };

    /* חישוב reminder_datetime */
    if (taskRow.due_date && /^\d{4}-\d{2}-\d{2}$/.test(taskRow.due_date)){
      const [hRaw,mRaw] = (gptData.reminder_time||'12:00').split(':');
      const pad = n=>n.toString().padStart(2,'0');
      const tzDate = new Date();
      tzDate.setFullYear(+taskRow.due_date.split('-')[0]);
      tzDate.setMonth(+taskRow.due_date.split('-')[1]-1);
      tzDate.setDate (+taskRow.due_date.split('-')[2]);
      tzDate.setHours(+pad(hRaw)); tzDate.setMinutes(+pad(mRaw)); tzDate.setSeconds(0);
      if (tzDate < new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Jerusalem'})))
        tzDate.setDate(tzDate.getDate()+1);
      taskRow.reminder_datetime = tzDate.toISOString();
    }

    await db.collection('tasks').doc(taskRow.task_id).set(taskRow);

    const confirm = `
💡 סגור! הוספתי את זה לרשימה שלך:

📝 משימה: ${taskRow.task_name||'לא זוהתה'}
📁 קטגוריה: ${taskRow.category || 'כללי'}
📅 יעד: ${formatDueDate(taskRow.due_date)}
🔁 תדירות: ${taskRow.frequency || 'חד פעמי'}
⏰ תזכורת: ${formatFriendlyReminder(taskRow.reminder_datetime)}
`.trim();
    await sendWhatsappMessage(phone, confirm);
    res.sendStatus(200);

  } catch(err){
    console.error('🔥 שגיאה כללית ב-/webhook:', err);
    res.sendStatus(500);
  }
});

/* ------------------------------------------------------------------ */
app.listen(PORT, ()=>console.log(`🚀 שרת פעיל על פורט ${PORT}`));
