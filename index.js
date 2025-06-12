/* ------------------------------------------------------------------
   Imports
------------------------------------------------------------------ */
import express      from 'express';
import bodyParser   from 'body-parser';
import dotenv       from 'dotenv';
import axios        from 'axios';
import { Storage }  from '@google-cloud/storage';

import { db }       from './firebase.js';
import fs           from 'node:fs/promises';
import path         from 'node:path';

import {
  analyzeMessageWithGPT,
  modifyTaskSchema,
  loadUserMemory,
  openai,
  parseFrequency,
  extractTimeFromText,
  tagsFromCaption,
} from './gpt.js';
import { updateUserMemory, learnFromMessage } from './updateUserMemory.js';
import { ensureCategory, ensurePerson }       from './normalize.js';

dotenv.config();

/* ------------------------------------------------------------------
   Global‑level constants
------------------------------------------------------------------ */
const storage = new Storage().bucket(process.env.GCLOUD_BUCKET);
const PORT    = process.env.PORT || 10_000;
const app     = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended:false }));

/** סט של משתמשים מורשים */
const allowedUsers   = new Set();
const BOT_ID_INSTANCE= process.env.BOT_ID_INSTANCE;
const BOT_TOKEN      = process.env.BOT_TOKEN;

/* ------------------------------------------------------------------
   Helper / Formatter functions
------------------------------------------------------------------ */
/**
 * ממיר ‏ISO → DD.MM (he-IL)  או "לא צוין".
 */
function formatDueDate(iso){
  if(!iso) return 'לא צוין';
  return new Date(iso).toLocaleDateString('he-IL',{day:'2-digit',month:'2-digit'});
}

/**
 * מחזיר תזכורת ידידותית:
 *   <7 ימים → יום‑שבוע + שעה
 *   אחרת     → תאריך + שעה
 */
function formatFriendlyReminder(iso){
  if(!iso) return 'לא נקבעה';
  const now   = Date.now()+3*60*60*1000;           // Asia/Jerusalem offset
  const diffD = (new Date(iso).getTime()-now)/(1000*60*60*24);
  return new Date(iso).toLocaleString('he-IL', diffD<=7 ?
    {weekday:'long',hour:'2-digit',minute:'2-digit'} :
    {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
}

/**
 * שולח הודעת WhatsApp דרך Green‑API
 */
async function sendWhatsappMessage(phone,message){
  const chatId = phone.includes('@c.us')?phone:`${phone}@c.us`;
  try{
    await axios.post(`https://api.green-api.com/waInstance${BOT_ID_INSTANCE}/sendMessage/${BOT_TOKEN}`,{chatId,message});
    console.log('📤 נשלחה הודעה ל‑',chatId);
  }catch(err){
    console.error('❌ שגיאה בשליחה:',err.response?.data||err.message);
  }
}

/**
 * יוצר/מעדכן משתמש במאגר "users" ומוסיף ל‑allowedUsers
 */
async function ensureUserExists(phoneDigits){
  const userId = 'usr_'+phoneDigits.slice(-6);
  const ref    = db.collection('users').doc(userId);
  const snap   = await ref.get();
  if(!snap.exists){
    await ref.set({ user_id:userId, phone:phoneDigits, created_at:new Date().toISOString() });
    console.log('👤 יוזר חדש:',phoneDigits);
  }
  allowedUsers.add(phoneDigits);
}

/**
 * מחזיר את אחרונת המשימות של משתמש (לפי created_at) או null
 */
async function getLastTask(userId){
  const snap = await db.collection(`tasks/${userId}/user_tasks`).orderBy('created_at','desc').limit(1).get();
  if(snap.empty) return null;
  const d = snap.docs[0];
  return {...d.data(), task_id:d.id};
}

/**
 * מעדכן מסמך משימה קיים עם אובייקט changes
 */
async function updateTaskInFirestore(userId, taskId, changes){
  await db.doc(`tasks/${userId}/user_tasks/${taskId}`).update(changes);
}

/* ------------------------------------------------------------------
   Bootstrapping allowedUsers
------------------------------------------------------------------ */
(async ()=>{
  const snap = await db.collection('users').get();
  snap.forEach(d=>{
    const p=(d.data().phone||'').replace(/^0/,'972');
    if(p) allowedUsers.add(p);
  });
  console.log('🟢 allowed users:',Array.from(allowedUsers));
})();

/* ------------------------------------------------------------------
   Main Webhook route – task / note + update‑task flow
------------------------------------------------------------------ */
app.post('/webhook', async (req,res)=>{
  try{
    /* ---------- 0. Sanity & basic vars ---------- */
    const { typeWebhook:type, senderData, messageData } = req.body;
    if(type!=='incomingMessageReceived') return res.sendStatus(200);

    const chatId  = senderData?.chatId;
    const message = messageData?.textMessageData?.textMessage||'';
    if(!chatId?.endsWith('@c.us')||!message.trim()) return res.sendStatus(200);

    const phoneDigits = chatId.replace('@c.us','');
    await ensureUserExists(phoneDigits);
    if(!allowedUsers.has(phoneDigits)) return res.sendStatus(200);

    const userId = 'usr_'+phoneDigits.slice(-6);

    /* ---------- 1. ניתוח GPT בסיסי ---------- */
    const gptData = await analyzeMessageWithGPT(message,userId);

    /* ---------- 2. ניסיון עדכון משימה אחרונה ---------- */
    const lastTask = await getLastTask(userId);
    if(lastTask){
      const payload = {
        model:'gpt-4o-mini',
        messages:[
          {role:'system',content:'קיבלת משימה ישנה והודעה חדשה. אם זו הודעה של עדכון, החזר רק את השדות שצריך לעדכן.'},
          {role:'user',content:`משימה קודם:\n${JSON.stringify(lastTask,null,2)}\n\nהודעה חדשה:\n${message}`}
        ],
        functions:[modifyTaskSchema],
        function_call:{name:'modify_task'}
      };
      const editRes = await openai.chat.completions.create(payload);
      const fc      = editRes.choices[0].message.function_call;
      if(fc?.name==='modify_task'){
        const changes = JSON.parse(fc.arguments||'{}');
        if(Object.keys(changes).length){
          await updateTaskInFirestore(userId,lastTask.task_id,changes);
          await sendWhatsappMessage(phoneDigits,'🔁 עודכנתי את המשימה הקודמת ✅');
          return res.sendStatus(200);
        }
      }
    }

    /* ---------- 3. יצירת משימה או פתק חדש ---------- */
    if(gptData.entry_type==='note'){
      // פתק חדש
      const entry_id = 'ent_'+Date.now();
      await db.collection('entries').doc(entry_id).set({
        entry_id,
        user_id:userId,
        entry_type:'note',
        title:gptData.note_title,
        body:gptData.note_body,
        created_at:new Date().toISOString()
      });
      await sendWhatsappMessage(phoneDigits,`📝 הערה נשמרה!\nכותרת: ${gptData.note_title}`);
      return res.sendStatus(200);
    }

    // task חדשה
    const taskRow={
      task_id : 'tsk_'+Date.now(),
      user_id,
      phone_number:phoneDigits,
      original_text:message,
      task_name : gptData.task_name,
      category  : gptData.category||'כללי',
      categoryId: await ensureCategory(gptData.category),
      personId  : await ensurePerson(gptData.person_name,gptData.person_role),
      due_date  : gptData.due_date,
      frequency : gptData.frequency,
      reminder_datetime:'',
      was_sent  : false,
      created_at:new Date().toISOString()
    };
    // reminder_datetime חישוב
    if(taskRow.due_date && /^\d{4}-\d{2}-\d{2}$/.test(taskRow.due_date)){
      const [h,m]=(gptData.reminder_time||'12:00').split(':');
      const [Y,M,D]=taskRow.due_date.split('-').map(Number);
      const d=new Date(Date.UTC(Y,M-1,D,+h,+m));
      if(d<new Date()) d.setUTCDate(d.getUTCDate()+1);
      taskRow.reminder_datetime=d.toISOString();
    }
    await db.collection('tasks').doc(userId).collection('user_tasks').doc(taskRow.task_id).set(taskRow);

    const confirm=`💡 סגור! הוספתי לרשימה שלך:\n📝 ${taskRow.task_name}\n📅 יעד: ${formatDueDate(taskRow.due_date)}\n⏰ ${formatFriendlyReminder(taskRow.reminder_datetime)}`;
    await learnFromMessage(userId,gptData);
    await sendWhatsappMessage(phoneDigits,confirm);
    return res.sendStatus(200);
  }catch(err){
    console.error('🔥 שגיאה כללית ב-/webhook:',err);
    return res.sendStatus(500);
  }
});

/* ------------------------------------------------------------------
   Reminder Job – every 1 min (checkReminders)
------------------------------------------------------------------ */
async function checkReminders(){
  console.log('▶️ checkReminders',new Date().toISOString());
  const usersSnap=await db.collection('users').get();
  for(const userDoc of usersSnap.docs){
    const userId=userDoc.id;
    const tasksSnap=await db.collection(`tasks/${userId}/user_tasks`).where('was_sent','==',false).get();
    for(const doc of tasksSnap.docs){
      const task=doc.data();
      if(!task.reminder_datetime) continue;
      const nowISR=new Date(Date.now()+3*60*60*1000);
      if(nowISR<new Date(task.reminder_datetime)) continue;
      const chatId=`${task.phone_number}@c.us`;
      await sendWhatsappMessage(chatId,`⏰ תזכורת: ${task.task_name}`);
      await doc.ref.update({was_sent:true});
    }
  }
}
setInterval(checkReminders,60*1000);

/* ------------------------------------------------------------------ */
app.listen(PORT,()=>console.log(`🚀 שרת פעיל על פורט ${PORT}`));
