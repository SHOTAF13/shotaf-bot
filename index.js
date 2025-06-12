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
  loadUserMemory,
  openai,
  modifyTaskSchema
} from './gpt.js';

import { updateUserMemory, learnFromMessage } from './updateUserMemory.js';
import { ensureCategory, ensurePerson }       from './normalize.js';
import { sendWhatsappMessage } from './whatsapp.js';

dotenv.config();

/* ------------------------------------------------------------------
   Global constants
------------------------------------------------------------------ */
const storage = new Storage().bucket(process.env.GCLOUD_BUCKET);
const PORT    = process.env.PORT || 10_000;
const app     = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended:false }));

const allowedUsers    = new Set();
const BOT_ID_INSTANCE = process.env.BOT_ID_INSTANCE;
const BOT_TOKEN       = process.env.BOT_TOKEN;

/* ------------------------------------------------------------------
   Generic helpers
------------------------------------------------------------------ */
const STOPWORDS = new Set(['את','עם','של','על','ל','לי','ב']);               // מינימלי

function tokenize(str){
  return str
    .toLowerCase()
    .replace(/["'״׳«»]/g,'')
    .split(/[\s,.;!?()/\-]+/)
    .filter(w=>w && !STOPWORDS.has(w));
}
function jaccard(a,b){
  const A=new Set(a), B=new Set(b);
  const inter=[...A].filter(x=>B.has(x)).length;
  const unionSize = new Set([...A,...B]).size;
  return unionSize ? inter/unionSize : 0;
}

function formatDueDate(iso){
  if(!iso) return 'לא צוין';
  return new Date(iso).toLocaleDateString('he-IL',
          {day:'2-digit',month:'2-digit'});
}
function formatFriendlyReminder(iso){
  if(!iso) return 'לא נקבעה';
  const now   = Date.now()+3*60*60*1000;   // Asia/Jerusalem offset
  const diffD = (new Date(iso).getTime()-now)/(1000*60*60*24);
  return new Date(iso).toLocaleString('he-IL',
          diffD<=7 ?
          {weekday:'long',hour:'2-digit',minute:'2-digit'} :
          {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
}
async function sendWhatsappMessage(phone,msg){
  const chatId = phone.includes('@c.us')?phone:`${phone}@c.us`;
  await axios.post(
    `https://api.green-api.com/waInstance${BOT_ID_INSTANCE}/sendMessage/${BOT_TOKEN}`,
    {chatId,message:msg});
}

/* ---------- Firestore wrappers ---------- */
async function ensureUserExists(phone){
  const uid='usr_'+phone.slice(-6);
  const ref=db.collection('users').doc(uid);
  if(!(await ref.get()).exists){
    await ref.set({user_id:uid,phone});
  }
  allowedUsers.add(phone);
}
async function getLastTask(userId){
  const snap=await db.collection(`tasks/${userId}/user_tasks`)
                     .orderBy('created_at','desc').limit(1).get();
  if(snap.empty) return null;
  const d=snap.docs[0];
  return {...d.data(),task_id:d.id};
}
async function updateTaskInFirestore(userId,taskId,changes){
  await db.doc(`tasks/${userId}/user_tasks/${taskId}`).update(changes);
}

/* ------------------------------------------------------------------
   Bootstrap allowed users once at startup
------------------------------------------------------------------ */
(async ()=>{
  const snap=await db.collection('users').get();
  snap.forEach(d=>{
    const p=(d.data().phone||'').replace(/^0/,'972');
    if(p) allowedUsers.add(p);
  });
  console.log('🟢 allowed users:',Array.from(allowedUsers));
})();

/* ------------------------------------------------------------------
   Main webhook
------------------------------------------------------------------ */
app.post('/webhook',async (req,res)=>{
  try{
    const { typeWebhook:type,senderData,messageData } = req.body;
    if(type!=='incomingMessageReceived') return res.sendStatus(200);

    const chatId  = senderData?.chatId;
    const message = messageData?.textMessageData?.textMessage || '';
    if(!chatId?.endsWith('@c.us') || !message.trim()) return res.sendStatus(200);

    const phone   = chatId.replace('@c.us','');
    await ensureUserExists(phone);
    if(!allowedUsers.has(phone)) return res.sendStatus(200);

    const userId  = 'usr_'+phone.slice(-6);

    /* ------- GPT analysis ------- */
    const gptData = await analyzeMessageWithGPT(message,userId);

    /* ------- Try auto-update ------- */
    const lastTask = await getLastTask(userId);
    if(lastTask){
      const diffMin = (Date.now()-Date.parse(lastTask.created_at))/60000;
      const sim     = jaccard(tokenize(lastTask.task_name),
                              tokenize(gptData.task_name));
      const MAY_UPDATE = diffMin<=5 && sim>=0.5;

      if(MAY_UPDATE){
        const payload={
          model:'gpt-4o-mini',
          messages:[
            {role:'system',
             content:'קיבלת משימה ישנה והודעה חדשה. אם זו הודעה של עדכון, החזר רק את השדות שצריך לעדכן. אחרת החזר {}.'},
            {role:'user',
             content:`משימה קודם:\n${JSON.stringify(lastTask,null,2)}\n\nהודעה חדשה:\n${message}`}
          ],
          functions:[modifyTaskSchema],
          function_call:{name:'modify_task'}
        };
        const editRes = await openai.chat.completions.create(payload);
        const fc      = editRes.choices[0].message.function_call;
        if(fc?.name==='modify_task'){
          const changes=JSON.parse(fc.arguments||'{}');
          if(Object.keys(changes).length){
            await updateTaskInFirestore(userId,lastTask.task_id,changes);
            await sendWhatsappMessage(phone,'🔁 עודכנתי את המשימה הקודמת ✅');
            return res.sendStatus(200);
          }
        }
      }
    }

    /* ------- Create new Note or Task ------- */
    if(gptData.entry_type==='note'){
      const id='ent_'+Date.now();
      await db.collection('entries').doc(id).set({
        entry_id:id,user_id:userId,entry_type:'note',
        title:gptData.note_title,body:gptData.note_body,
        created_at:new Date().toISOString()
      });
      await sendWhatsappMessage(phone,`📝 הערה נשמרה!\nכותרת: ${gptData.note_title}`);
      return res.sendStatus(200);
    }

    const taskRow={
      task_id : 'tsk_'+Date.now(),
      user_id : userId,
      phone_number:phone,
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
    if(taskRow.due_date && /^\d{4}-\d{2}-\d{2}$/.test(taskRow.due_date)){
      const [h,m]=(gptData.reminder_time||'12:00').split(':');
      const [Y,M,D]=taskRow.due_date.split('-').map(Number);
      const d=new Date(Date.UTC(Y,M-1,D,+h,+m));
      if(d<new Date()) d.setUTCDate(d.getUTCDate()+1);
      taskRow.reminder_datetime=d.toISOString();
    }
    await db.collection('tasks').doc(userId)
            .collection('user_tasks').doc(taskRow.task_id).set(taskRow);

    const confirm=`💡 נוספה משימה:\n📝 ${taskRow.task_name}\n📅 ${formatDueDate(taskRow.due_date)}\n⏰ ${formatFriendlyReminder(taskRow.reminder_datetime)}`;
    await learnFromMessage(userId,gptData);
    await sendWhatsappMessage(phone,confirm);
    return res.sendStatus(200);

  }catch(err){
    console.error('🔥 שגיאה ב-/webhook:',err);
    return res.sendStatus(500);
  }
});

/* ------------------------------------------------------------------
   Simple reminder loop (1 min)
------------------------------------------------------------------ */
async function checkReminders(){
  const users=await db.collection('users').get();
  for(const u of users.docs){
    const uid=u.id;
    const open=await db.collection(`tasks/${uid}/user_tasks`)
                       .where('was_sent','==',false).get();
    for(const doc of open.docs){
      const t=doc.data();
      if(!t.reminder_datetime) continue;
      const nowISR=new Date(Date.now()+3*60*60*1000);
      if(nowISR<new Date(t.reminder_datetime)) continue;
      await sendWhatsappMessage(`${t.phone_number}@c.us`,`⏰ תזכורת: ${t.task_name}`);
      await doc.ref.update({was_sent:true});
    }
  }
}
setInterval(checkReminders,60_000);

/* ------------------------------------------------------------------ */
app.listen(PORT,()=>console.log(`🚀 API on :${PORT}`));
