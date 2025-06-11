/* ------------------------------------------------------------------ */
/*                             Imports                                */
/* ------------------------------------------------------------------ */
import express                    from 'express';
import bodyParser                 from 'body-parser';
import dotenv                     from 'dotenv';
import axios                      from 'axios';
//import { tagsFromCaption }  from './gpt.js';      
import { Storage }          from '@google-cloud/storage'; 

import { db }                     from './firebase.js';
import fs                         from 'node:fs/promises';
import path                       from 'node:path';
import {
  analyzeMessageWithGPT,
  //answerUserQuestionWithGPT,
  modifyTaskSchema,
  loadUserMemory,
  openai
  //updateTaskSchema 
}                                 from './gpt.js';
import { updateUserMemory, learnFromMessage } from './updateUserMemory.js';
import { ensureCategory, ensurePerson } from './normalize.js';
dotenv.config();

console.log('✅ ENV BOT_ID_INSTANCE:', process.env.BOT_ID_INSTANCE);
console.log('✅ ENV BOT_TOKEN:', process.env.BOT_TOKEN);


/* ------------------------------------------------------------------ */
/*                        Global-level constants                      */
/* ------------------------------------------------------------------ */
const storage = new Storage().bucket(process.env.GCLOUD_BUCKET);
const PORT = process.env.PORT || 10000;
const app  = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended:false }));

/** סט של משתמשים מורשים 972xxxxxxxx  */
const allowedUsers = new Set();
const BOT_ID_INSTANCE = process.env.BOT_ID_INSTANCE;
const BOT_TOKEN       = process.env.BOT_TOKEN;
const BOT_PHONE_ID    = `${process.env.BOT_PHONE}@c.us`;   // 972…@c.us



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
  async function getPersonSummary(userId, personName){
    const mem  = await loadUserMemory(userId);
    const role = mem.contacts?.[personName] || '';
    const snap = await db.collection('tasks')
   .doc(userId)
   .collection('user_tasks')
   .get();

  const relevant = snap.docs
    .map(d=>d.data())
    .filter(t=>t.task_name.includes(personName));

  const tasksTxt = relevant.length
        ? relevant.map(t=>`• ${t.task_name} – ${t.due_date || 'ללא תאריך'}`).join('\n')
        : 'אין משימות פתוחות';

  return `${personName} ${role?`– ${role}`:''}\n${tasksTxt}`;
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



/**
 * שולח הודעת WhatsApp למספר (לפי Green-API instance/token במפת המשתמשים)
 */
async function sendWhatsappMessage(phone, message) {
  const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
     try {
    await axios.post(`https://api.green-api.com/waInstance${BOT_ID_INSTANCE}/sendMessage/${BOT_TOKEN}`, {
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
// טוען רשימת לקוחות מורשים בלבד
(async ()=>{
  const snap = await db.collection('users').get();
  snap.forEach(doc=>{
    const p = (doc.data().phone||'').replace(/^0/,'972');
    if (p) allowedUsers.add(p);
  });
  console.log('🟢 allowed users:', Array.from(allowedUsers));
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
async function ensureUserExists(phoneDigits) {

  const userId = 'usr_' + phoneDigits.slice(-6);
  const docRef = db.collection('users').doc(userId);
  const snap = await docRef.get();

  if (!snap.exists) {
    // יוזר חדש – מוסיף ל-Firestore
    await docRef.set({
      user_id: userId,
      phone: phoneDigits,
      name: '',                      // ← מקום לשם בהמשך
      first_message: true,          // ← זיהוי משתמש חדש
      created_at: new Date().toISOString()
    });
    console.log('👤 יוזר חדש נוסף:', phoneDigits);
  }

  // תמיד מוסיף ל־Set (גם אם כבר קיים)
  allowedUsers.add(phoneDigits);
}





app.post('/webhook', async (req,res)=>{
  try {
    /* ---------- sanity checks ---------- */
    const { typeWebhook:type, senderData, messageData } = req.body;

const sender  = senderData?.sender;
const chatId  = senderData?.chatId;
const message = messageData?.textMessageData?.textMessage || '';



/* --------------- HARD FILTERS --------------- */
// 1. חייב להיות טייפ הודעה נכנסת (לא state / outgoing / history)
if (type !== 'incomingMessageReceived') return res.sendStatus(200);

// 2. טפל רק בצ'אטים פרטיים (‎@c.us). כל ‎@g.us, ‎@broadcast → החוצה
if (!chatId?.endsWith('@c.us')) return res.sendStatus(200);

// 3. חובה שתהיה הודעת טקסט אמיתית
if (!message.trim()) return res.sendStatus(200);

// 4. המשתמש חייב להופיע ב-Firestore
const phoneDigits = chatId.replace('@c.us','');   // chatId==sender בצ'אט פרטי
await ensureUserExists(phoneDigits);

const memory = await loadUserMemory('usr_'+phoneDigits.slice(-6));

// אם יש הצעה בהמתנה והמשתמש עונה
if (memory.__pendingSuggest && /^(כן|לא)$/i.test(message.trim())){
  if (/כן/i.test(message)){
    memory.habits ||= {};
    const {tag,freq,time} = memory.__pendingSuggest;
    memory.habits[tag] = {freq,time};
    await sendWhatsappMessage(phoneDigits,
      `מעולה! "${tag}" נוסף להרגלים הקבועים ✨`);
  }
  delete memory.__pendingSuggest;
  await db.collection('user_memory').doc('usr_'+phoneDigits.slice(-6)).set(memory);
  return res.sendStatus(200);
}


/* ------- (אפשר להשאיר כאן console.log לצורכי בדיקה) ------- */
console.log('💬 Got msg from', phoneDigits, ':', message);


    if (!allowedUsers.has(phoneDigits)) return res.sendStatus(200);

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
    const phone     = phoneDigits;  
    const userId    = 'usr_'+phone.slice(-6);
    const isQuestion= message.trim().endsWith('?');

    // שאלות אישיות?
const whoRegex = /^מי זה\s+(.+?)\?*$/;
const whatRegex = /^מה יש לי (?:עם|לגבי)\s+(.+?)\?*$/;
let m;
if ((m = message.match(whoRegex)) || (m = message.match(whatRegex))){
  const name = m[1].trim();
  const summary = await getPersonSummary(userId, name);
  await sendWhatsappMessage(phone, summary);
  return res.sendStatus(200);
}


    /* ---------- 1. Q&A path ---------- */
    if (isQuestion) {
      const memory = await loadUserMemory(userId);
    //const answer = await answerUserQuestionWithGPT(message, memory, userId); - קורא לפוקנציה שמאפשרת לשאול שאלות 
      await sendWhatsappMessage(phone, answer);
      return res.sendStatus(200); 
    }

    // מחזיר את המשימה האחרונה של המשתמש לפי תאריך יצירה
  async function getLastTask(userId) {
    const snap = await db.collection(`tasks/${userId}/user_tasks`)
      .orderBy('created_at', 'desc')  // ודא שאתה שומר את השדה הזה
      .limit(1)
       .get();

       if (snap.empty) return null;

        const doc = snap.docs[0];
  return { ...doc.data(), task_id: doc.id };
}

  // מעדכן את המשימה הקיימת עם שינויים שהוחזרו מ־GPT
  async function updateTaskInFirestore(userId, taskId, changes) {
   const ref = db.doc(`tasks/${userId}/user_tasks/${taskId}`);
   await ref.update(changes);
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

    /* ---------- 4. Weekly summary ---------- 
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

const allFilesRegex = /כל\s+(הקבלות|הקבצים|המתכונים)\s*$/;  // לדוגמה: "כל הקבלות", "כל המתכונים"
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
  */
// בודק אם ההודעה החדשה  קשורה להודעה הקודמת ואם כן משנה . 

 // 3) נסיון עדכון אוטומטי
 const lastTask = await getLastTask(userId);
 if (lastTask) {
  console.dir(modifyTaskSchema, { depth: null });
   const editRes = await openai.chat.completions.create({
     model: 'gpt-4o-mini',
     messages: [
       { role: 'system',  content: 'קיבלת משימה ישנה והודעה חדשה. אם זו הודעה של עדכון, החזר רק את השדות שצריך לעדכן.' },
       { role: 'user',    content: `משימה קודם:\n${JSON.stringify(lastTask, null,2)}\n\nהודעה חדשה:\n${message}` }
     ],
       functions: [ modifyTaskSchema ],
      function_call: { name: 'modify_task' }
   });

  console.log('🔍 updateTaskSchema is:', modifyTaskSchema);
  console.log('🔍 type of parameters:', typeof modifyTaskSchema.parameters);
// 2. הדפס את מה שהולך באמת לספרייה
console.log('🔍 updateTaskSchema.parameters:', JSON.stringify(modifyTaskSchema.parameters, null, 2));

   // לוג פשוט כדי לדבג
   console.log('🔄 editRes:', JSON.stringify(editRes.choices[0],null,2));
   // 2. לוג של הפיילוד המלא
  console.log('📤 Sending payload to OpenAI.chat.completions.create:\n', 
  JSON.stringify(payload, null, 2)
  

);

   const call = editRes.choices[0].message.function_call;
   if (call && call.name === 'modify_task') {
     const changes = JSON.parse(call.arguments || '{}');
     // אם אין שינויים אמיתיים, נמשיך הלאה
     if (Object.keys(changes).length > 0) {
       await updateTaskInFirestore(userId, lastTask.task_id, changes);
       await sendWhatsappMessage(phone, '🔁 עודכנתי את המשימה הקודמת ✅');
       return res.sendStatus(200);
     }
   }
 }

    /* ---------- 5. TASK (default) ---------- */
    const taskRow = {
      task_id   : 'tsk_'+Date.now(),
      user_id   : userId,
      phone_number: phone,
      original_text: message,
      task_name : gptData.task_name,
      category  : gptData.category || 'כללי',
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

    await db.collection('tasks')
        .doc(userId)                   // ← למשל: usr_676706
        .collection('user_tasks')     // ← תת-אוסף קבוע
        .doc(taskRow.task_id)
        .set(taskRow);

    const confirm = `
💡 סגור! הוספתי את זה לרשימה שלך:

📝 משימה: ${taskRow.task_name||'לא זוהתה'}
📁 קטגוריה: ${taskRow.category || 'כללי'}
📅 יעד: ${formatDueDate(taskRow.due_date)}
🔁 תדירות: ${taskRow.frequency || 'חד פעמי'}
⏰ תזכורת: ${formatFriendlyReminder(taskRow.reminder_datetime)}
`.trim();
 await learnFromMessage(userId, gptData);   // ← חדש
 await sendWhatsappMessage(phone, confirm);
 res.sendStatus(200);


  } catch(err){
    console.error('🔥 שגיאה כללית ב-/webhook:', err);
    res.sendStatus(500);
  }
});

/* ------------------------------------------------------------------ */
app.listen(PORT, ()=>console.log(`🚀 שרת פעיל על פורט ${PORT}`));
