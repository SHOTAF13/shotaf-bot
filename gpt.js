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
  if (/כל יום/i.test(txt))           return 'יומי';
  if (/פעמיים בשבוע|כל.*שבוע/i.test(txt)) return 'שבועי';
  if (/כל חודש|חודשי/i.test(txt))     return 'חודשי';
  return '';
}


/* ------------------------------------------------------------------ */
/*                        GPT ANALYSIS                                */
/* ------------------------------------------------------------------ */
export async function analyzeMessageWithGPT(message, userId=null){
  const today = new Date().toISOString().split('T')[0];

  const prompt = ` אתה עוזר אישי דיגיטלי אבל שותף מלא של הבן אדם שמדבר איתך 
  אתה מבין מי הבן אדם איך הוא מדבר מה הוא רוצה להיות ומדבר איתו כמו החבר הכי טוב שלו לפי מה שהוא  .
קבל משפט בעברית ↔ החזר JSON עם השדות הבאים (עברית בלבד):

• entry_type  - "task"‎ / ‎"note"‎
  ▸ "task"  = משפט שמתחיל ב"צריך/לה…/קבע/שלח" או כולל יום/שעה/תדירות
  ▸ "note"  = רעיון / זיכרון / תובנה ללא צורך בביצוע
אל תשתמש במילה "חשוב" או "דחוף" לקביעת הסוג.

• task_name      - שם פעולה (אם entry_type=task)
• category       - קטגוריה בקצרה
• due_date       - YYYY-MM-DD (אם אין תאריך → "")
• frequency      - ‎"" / "יומי" / "שבועי" / "חודשי" / "פעם בשבוע" …
• reminder_time  - HH:MM או ‎"" (אם אין שעה ברורה)
• note_title     - אם פתק
• note_body      - גוף הפתק
• person_name    - אם מופיע שם
• person_role    - תפקיד של אותו אדם

❗ דוגמאות:
Input: "להשקות את העציצים פעם בשבוע"
Output: {"entry_type":"task","task_name":"להשקות את העציצים","category":"בית","frequency":"שבועי"}

Input: "רעיון: להקים פודקאסט על יין"
Output: {"entry_type":"note","note_title":"רעיון לפודקאסט","note_body":"להקים פודקאסט על יין"}

Input: "צריך כל יום ראשון להשקות עציצים"
Output: {"entry_type":"task","task_name":"להשקות עציצים","frequency":"שבועי"}

Input: "שיר חדש שמעתי ברדיו"
Output: {"entry_type":"note","note_title":"שיר חדש","note_body":"שמעתי ברדיו"}


החזר JSON נקי בלבד.`.trim();

  try {
    const res = await openai.chat.completions.create({
      model:'gpt-4.1-nano-2025-04-14',
      messages:[{role:'user',content:prompt}]
    });

    const text   = res.choices[0]?.message?.content||'{}';
    const parsed = JSON.parse(text.trim().replace(/^```(json)?|```$/g,''));

    parsed.frequency ||= parseFrequency(message);
    if (parsed.entry_type==='note' && !parsed.note_title && parsed.note_body)
      parsed.note_title = parsed.note_body.slice(0,40);

    const dateFromText = parseHebrewDate(message);
    if (dateFromText) parsed.due_date = dateFromText;
    parsed.reminder_time = extractTimeFromText(message);

    if (userId){
      const newMem = {
        ...(parsed.person_name && { name:parsed.person_name }),
        ...(parsed.person_role && { role:parsed.person_role }),
        ...(parsed.task_name   && {
          tags:[parsed.task_name],
          keywords:{ [parsed.task_name]:parsed.category }
        }),
        ...(parsed.category    && { topics:[parsed.category] })
      };
      if (Object.keys(newMem).length){
        console.log('🧠 Updating user memory with:', newMem);
        await updateUserMemory(userId, newMem);
      }
    }
    // fallback – verb in infinitive/imperative = task
    const imperative = /^(צריך|התקשר|להתקשר|קבע|לקבוע|שלח|לשלוח|כתוב|לכתוב)/;
    if (!parsed.entry_type && imperative.test(message)) {
    parsed.entry_type = 'task';
    parsed.task_name  ||= message.replace(imperative,'').trim();
}

    return parsed;

  } catch(e){
    console.error('❌ Failed to parse GPT response:', e.message||e);
    return getEmptyResponse();
  }

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
