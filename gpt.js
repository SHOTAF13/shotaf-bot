/* ------------------------------------------------------------------ */
/*                               IMPORTS                              */
/* ------------------------------------------------------------------ */
import dotenv        from 'dotenv';
import OpenAI        from 'openai';
import { db }        from './firebase.js';
import { updateUserMemory } from './updateUserMemory.js';

dotenv.config();

/* ------------------------------------------------------------------ */
/*                            CONSTANTS                               */
/* ------------------------------------------------------------------ */
const openai = new OpenAI({ apiKey: process.env.KEY_GPT });

/** המרה יום-שם → מספר-יום (0=Sunday) */
const daysMap = {
  Sunday:0, Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6,
  'יום ראשון':0, 'יום שני':1, 'יום שלישי':2, 'יום רביעי':3,
  'יום חמישי':4, 'יום שישי':5, 'יום שבת':6
};

/* ------------------------------------------------------------------ */
/*                            FUNCTION SCHEMA                         */
/* ------------------------------------------------------------------ */
const analyzeSchema = {
  name: 'analyze_message',
  description: 'סיווג הודעה מהמשתמש לשותף האישי',
  parameters: {
    type: 'object',
    properties: {
      entry_type:    { enum:['task','note'], description:'task=משימה, note=פתק' },
      task_name:     { type:'string',  description:'שם המשימה (אם task)' },
      category:      { type:'string' },
      due_date:      { type:'string',  description:'YYYY-MM-DD או ריק' },
      frequency:     { type:'string' },
      reminder_time: { type:'string' },
      note_title:    { type:'string' },
      note_body:     { type:'string' },
      person_name:   { type:'string' },
      person_role:   { type:'string' }
    },
    required: ['entry_type']
  }
};


/* ------------------------------------------------------------------ */
/*                     DATE / TIME HELPERS                            */
/* ------------------------------------------------------------------ */
function parseHebrewDate(txt){
  const today = new Date();
  const lower = txt.toLowerCase();

  if (lower.includes('היום'))  return today.toISOString().split('T')[0];
  if (lower.includes('מחר'))   return new Date(today.setDate(today.getDate()+1)).toISOString().split('T')[0];

  for (const [label,targetDay] of Object.entries(daysMap)){
    if (!txt.includes(label)) continue;
    let diff = (targetDay - today.getDay() + 7) % 7 || 7;
    const res = new Date(today); res.setDate(today.getDate()+diff);
    return res.toISOString().split('T')[0];
  }
  return '';
}

function extractTimeFromText(txt){
  const m = txt.match(/\b(0?[0-9]|1[0-9]|2[0-3]):([0-5][0-9])\b/);
  if (m) return m[0];
  if (txt.includes('בערב'))           return '20:00';
  if (txt.includes('בבוקר'))          return '08:00';
  if (txt.includes('בצהריים'))        return '13:00';
  if (txt.includes('אחה"צ')||txt.includes('אחר הצהריים')) return '17:00';
  return '12:00';
}

function parseFrequency(txt){
  if (/כל יום/i.test(txt))                     return 'יומי';
  if (/פעמיים בשבוע|כל.*שבוע/i.test(txt))     return 'שבועי';
  if (/כל יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/i.test(txt)) return 'שבועי';
  if (/כל חודש|חודשי/i.test(txt))             return 'חודשי';
  return '';
}


/* ------------------------------------------------------------------ */
/*                        GPT ANALYSIS (v2)                           */
/* ------------------------------------------------------------------ */
export async function analyzeMessageWithGPT(message, userId = null) {
  // 2.1 - קריאה ל-GPT עם function-calling
  let gptData;
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'אתה עוזר אישי דיגיטלי. בחר רק task או note.' },
        { role: 'user',   content: message }
      ],
      functions : [ analyzeSchema ],
      function_call: { name: 'analyze_message' }
    });

    gptData = JSON.parse(
      completion.choices[0].message.function_call.arguments
    );
  } catch (err) {
    console.error('❌ GPT function-call failed:', err);
    return getEmptyResponse();        // החזר מבנה ריק במקום להפיל את ה-bot
  }

  // 2.2 - השלמות לוגיקה מקומית (תאריך, שעה, frequency)
  gptData.frequency      ||= parseFrequency(message);
  gptData.due_date       ||= parseHebrewDate(message);
  gptData.reminder_time  ||= extractTimeFromText(message);

  if (gptData.entry_type === 'note' && !gptData.note_title && gptData.note_body)
    gptData.note_title = gptData.note_body.slice(0, 40);

  // 2.3 - עדכון זיכרון (כמו קודם – השארתי ללא שינוי)
  if (userId) {
    const newMem = {
      ...(gptData.person_name && { name: gptData.person_name }),
      ...(gptData.person_role && { role: gptData.person_role }),
      ...(gptData.task_name   && { tags:[gptData.task_name],
                                   keywords:{ [gptData.task_name]: gptData.category || 'כללי' }}),
      ...(gptData.category    && { topics:[gptData.category] })
    };
    if (Object.keys(newMem).length) {
      console.log('🧠 Updating user memory with:', newMem);
      await updateUserMemory(userId, newMem);
    }
  }

  return gptData;
}


export async function loadUserMemory(userId){
  const doc = await db.collection('user_memory').doc(userId).get();
  return doc.exists ? doc.data() : {};
}

export async function answerUserQuestionWithGPT(question, memory, userId=null){
  const notes = Object.keys(memory.keywords || {})
                      .filter(k=>memory.keywords[k]==='note');
  const notesBlock = notes.length ? notes.map(t=>`• ${t}`).join('\n') : 'אין פתקים שנשמרו';

  const prompt = `המשתמש שואל: "${question}"\n\nפתקי המשתמש:\n${notesBlock}\n\nלהלן מידע על מה שאתה יודע עליו:\n${JSON.stringify(memory,null,2)}\n\nענה בעברית קצרה.\n🟡 אם השאלה תואמת כותרת פתק – החזר "[NOTE] <כותרת>"\n🟢 אם יש קובץ מתאים החזר "[FILE] <כותרת>"\n🔴 אחרת – החזר "לא מצאתי מידע מתאים".`.trim();

  try{
    const res  = await openai.chat.completions.create({
      model:'gpt-4.1-nano-2025-04-14',
      messages:[{role:'user',content:prompt}]
    });

    let reply = res.choices[0]?.message?.content || 'לא מצאתי מידע.';

    if (reply.startsWith('[NOTE]') && userId){
      const title = reply.replace('[NOTE]','').trim();
      const snap  = await db.collection('entries')
                            .where('user_id','==',userId)
                            .where('title','==',title)
                            .limit(1).get();
      if (!snap.empty){
        const body = snap.docs[0].data().body || '';
        reply = `**${title}**\n${body}`;
      }
    }

    if (reply.startsWith('[FILE]') && userId){
      const title = reply.replace('[FILE]','').trim();
      const snap  = await db.collection('entries')
                            .where('user_id','==',userId)
                            .where('title','==',title)
                            .limit(1).get();
      if (!snap.empty){
        const { url } = snap.docs[0].data();
        reply = `📎 ${title}\n${url}`;
      }
    }

    return reply;
  }catch(e){
    console.error('❌ שגיאה בתשובת GPT:', e.message||e);
    return 'הייתה שגיאה בעיבוד השאלה שלך.';
  }
}

export async function tagsFromCaption(caption){
  const prompt = `כתוב רשימת תגיות (מילים בודדות) בעברית שמתארות את הביטוי:\n"${caption}"\nהחזר JSON עם מפתח יחיד "tags" שמכיל מערך מילים.\nדוגמה:\nInput: "קבלה חשמל מאי 2025"\nOutput: {"tags":["קבלה","חשמל","2025","מאי"]}`.trim();

  try{
    const res = await openai.chat.completions.create({
      model:'gpt-4o-mini',
      messages:[{role:'user',content:prompt}]
    });
    const txt   = res.choices[0]?.message?.content || '{}';
    const parsed= JSON.parse(txt.replace(/^```(json)?|```$/g,''));
    return Array.isArray(parsed.tags) ? parsed.tags : [];
  }catch(e){
    console.warn('⚠️ GPT tags failed', e.message);
    return [];
  }
}

function getEmptyResponse(){
  return {
    task_name:'',category:'',due_date:'',frequency:'',
    reminder_time:'12:00',person_name:'',person_role:''
  };
}

const STOPWORDS = new Set(['שלחתי','לי','כמה','מה','עלתה','עלות','כולל','עם','?',':','₪','€','$','לי']);

export async function findBestNoteMatch(question, userId){
  // 1. שלוף 50 הפתקים האחרונים של המשתמש
  const snap = await db.collection('entries')
    .where('user_id','==',userId)
    .where('entry_type','==','note')
    .orderBy('created_at','desc')
    .limit(100).get();

  if (snap.empty) return null;

  // 2. נרמל את השאלה לביטוי-מילים
  const qTokens = tokenize(question);

  let best = null;                 // {title, body, score}
  for (const doc of snap.docs){
    const { title, body } = doc.data();
    const text = `${title} ${body}`;
    const score = jaccard(tokenize(text), qTokens);
    if (!best || score > best.score) best = { title, body, score };
  }

  // 3. התאמה “טובה מספיק” = >0.25
  return best && best.score >= 0.25 ? best : null;
}

/* ----- helpers ----- */
function tokenize(str){
  return str
    .toLowerCase()
    .replace(/["“”„«»'’]/g,'')
    .split(/[\s,.;!?()/\-]+/)
    .filter(w=>w && !STOPWORDS.has(w));
}
function jaccard(setA, setB){
  const A = new Set(setA), B = new Set(setB);
  const intersect = [...A].filter(x=>B.has(x)).length;
  const union     = new Set([...A,...B]).size;
  return union ? intersect/union : 0;
}

