/* ------------------------------------------------------------------ */
/*                               IMPORTS                              */
/* ------------------------------------------------------------------ */
import dotenv  from "dotenv";
import OpenAI  from "openai";
import { db } from "./firebase.js";
import { updateUserMemory } from "./updateUserMemory.js";
import { getTopK }         from "./searchSimilar.js";

/* ------------------------------------------------------------------ */
/*                              CONFIG                                */
/* ------------------------------------------------------------------ */
dotenv.config();
export const openai = new OpenAI({ apiKey: process.env.KEY_GPT });

/* ------------------------------------------------------------------ */
/*                         GLOBAL CONSTANTS                           */
/* ------------------------------------------------------------------ */
// שמות הימים בעברית – שימושי להזרקת התאריך העכשווי אל GPT
const HEBREW_DAYS = [
  "יום ראשון", "יום שני", "יום שלישי",
  "יום רביעי", "יום חמישי", "יום שישי", "יום שבת"
];

/* ------------------------------------------------------------------ */
/*                            GPT SCHEMA                              */
/* ------------------------------------------------------------------ */
// Structure GPT must return when classifying a user message
export const analyzeSchema = {
  name: "analyze_message",
  description: "סיווג הודעה מהמשתמש לשותף האישי",
  parameters: {
    type: "object",
    properties: {
      entry_type   : { enum: ["task", "note"], description: "task = משימה, note = פתק" },
      task_name    : { type: "string", description: "שם המשימה (אם task)" },
      category     : { type: "string" },
      due_date     : { type: "string", description: "YYYY-MM-DD או ריק" },
      frequency    : { type: "string" },
      reminder_time: { type: "string" },
      note_title   : { type: "string" },
      note_body    : { type: "string" },
      person_name  : { type: "string" },
      person_role  : { type: "string" }
    },
    required: ["entry_type"]
  }
};

/* ------------------------------------------------------------------ */
/*                       SIMPLE HELPER FUNCTIONS                      */
/* ------------------------------------------------------------------ */
// זיהוי תדירות בעברית בסיסית
export function parseFrequency(txt) {
  if (/כל יום/i.test(txt))                                return "יומי";
  if (/פעמיים בשבוע|כל.*שבוע/i.test(txt))                return "שבועי";
  if (/כל יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/i) return "שבועי";
  if (/כל חודש|חודשי/i.test(txt))                        return "חודשי";
  return "";
}

// הוצאת שעה מהטקסט, או ברירת מחדל לפי מילת מפתח
export function extractTimeFromText(txt) {
  const m = txt.match(/\b(0?[0-9]|1[0-9]|2[0-3]):([0-5][0-9])\b/);
  if (m) return m[0];
  if (txt.includes("בערב"))            return "20:00";
  if (txt.includes("בבוקר"))           return "08:00";
  if (txt.includes("בצהריים"))         return "13:00";
  if (txt.includes("אחה"))             return "17:00"; // אחה"צ / אחר הצהריים
  return "12:00";
}

/* ------------------------------------------------------------------ */
/*       עדכון        */
/* ------------------------------------------------------------------ */

export const UpdateTaskSchema = {
  name: 'update_task',
  description: 'מעדכן משימה קיימת לפי נתונים חדשים מהמשתמש',
  parameters: {
    type: 'object',
    properties: {
      task_name: {
        type: 'string',
        description: 'שם המשימה החדש (אם המשתמש שינה אותו)'
      },
      due_date: {
        type: 'string',
        format: 'date',
        description: 'תאריך יעד חדש (בפורמט YYYY-MM-DD)'
      },
      reminder_time: {
        type: 'string',
        pattern: '^\\d{2}:\\d{2}$',
        description: 'שעת תזכורת מעודכנת (HH:mm)'
      },
      category: {
        type: 'string',
        description: 'קטגוריה מעודכנת למשימה'
      },
      frequency: {
        type: 'string',
        description: 'תדירות מעודכנת אם צוין שינוי (כמו "יומי", "שבועי")'
      }
    },
    required: []
  }
};


/* ------------------------------------------------------------------ */
/*         LEGACY DATE HELPERS (כיום לא בשימוש – שמור כגיבוי)        */
/* ------------------------------------------------------------------ */
/*
function parseHebrewDate(txt) {
  const now   = new Date();             // שמרנו עותק של היום
  const lower = txt.toLowerCase();

  if (lower.includes('היום')) {
    return now.toISOString().split('T')[0];
  }

  if (lower.includes('מחר')) {
    const tomorrow = new Date(now);      // יוצרים עותק חדש
    tomorrow.setDate(now.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }

  for (const [label, targetDay] of Object.entries(daysMap)) {
    if (!txt.includes(label)) continue;
    const today      = new Date();       // עותק נוסף של היום
    const currentDay = today.getDay();
    let diff = (targetDay - currentDay + 7) % 7;
    if (diff === 0) diff = 7;            // אם זה היום עצמו, נקבל שבוע הבא
    today.setDate(today.getDate() + diff);
    return today.toISOString().split('T')[0];
  }

  return '';
}

/**
 * מתקנת שנה בתאריך אם הוא כבר עבר:
 * - אם הגיעה שנה, מחזירים את השנה הנוכחית או הבאה כך שהתאריך יהיה בעתיד.
 
function correctYearIfPast(dateStr) {
  const inputDate = new Date(dateStr);
  const now       = new Date();

  // קבע שנה נוכחית
  inputDate.setFullYear(now.getFullYear());
  // אם עדיין לפני היום, נשדרג לשנה הבאה
  if (inputDate < now) {
    inputDate.setFullYear(now.getFullYear() + 1);
  }

  return inputDate.toISOString().split('T')[0];
}
*/

/* ------------------------------------------------------------------ */
/*                   MAIN: analyzeMessageWithGPT                       */
/* ------------------------------------------------------------------ */
export async function analyzeMessageWithGPT(message, userId = null) {
  /* ---------- 1) הכנת הקשר ומידע איש המשתמש ---------- */
  const hits   = await getTopK(userId, message);
  const context = hits
    .filter(h => h.score > 0.6)
    .map(h => formatDocForPrompt(h.doc_id))
    .join("\n\n---\n\n");

  const mem = userId ? await loadUserMemory(userId) : {};
  const profileText = JSON.stringify(mem.profile || {});

  /* ---------- 2) הזרקת התאריך הנוכחי ל‑GPT ---------- */
  const now       = new Date();
  const todayISO  = now.toISOString().split("T")[0];
  const todayName = HEBREW_DAYS[now.getDay()];

  const messages = [
    {
      role: "system",
      content:
        `היום הוא ${todayName}, התאריך הוא ${todayISO}.\n` +
        `פרופיל משתמש: ${profileText}\n` +
        `אתה עוזר אישי דיגיטלי. החזר מבנה JSON לפי הסכמה, ובחר רק task או note.`
    },
    { role: "user", content: message }
  ];

  /* ---------- 3) קריאה ל‑GPT ---------- */
  let gptData;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      functions: [analyzeSchema],
      function_call: { name: "analyze_message" }
    });

    gptData = JSON.parse(
      completion.choices[0].message.function_call.arguments
    );
  } catch (err) {
    console.error("❌ GPT function-call failed:", err);
    return getEmptyResponse();
  }

  /* ---------- 4) השלמות צד‑שרת (שעה, תדירות) ---------- */
  gptData.frequency      ||= parseFrequency(message);
  gptData.reminder_time  ||= extractTimeFromText(message);

  if (gptData.entry_type === "note" && !gptData.note_title && gptData.note_body)
    gptData.note_title = gptData.note_body.slice(0, 40);

  /* ---------- 5) עדכון זיכרון ---------- */
  if (userId) {
    const newProfile = {
      ...(gptData.person_name && gptData.person_role && {
        people: { [gptData.person_name]: gptData.person_role }
      }),
      ...(gptData.task_name && gptData.frequency && gptData.reminder_time && {
        habits: {
          [gptData.task_name]: {
            freq: gptData.frequency,
            time: gptData.reminder_time
          }
        }
      }),
      ...(gptData.category && {
        topics: [gptData.category]
      })
    };

    if (Object.keys(newProfile).length) {
      console.log("🧠 Updating user profile with:", newProfile);
      await updateUserMemory(userId, { profile: newProfile });
    }
  }

  return gptData;
}

/* ------------------------------------------------------------------ */
/*                REMAINING UTILITY / EXPORT FUNCTIONS                */
/* ------------------------------------------------------------------ */
export async function loadUserMemory(userId) {
  const doc = await db.collection("user_memory").doc(userId).get();
  return doc.exists ? doc.data() : {};
}

/*/  async function answerUserQuestionWithGPT(question, memory, userId=null){
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

/* ----- helpers ----- 
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
*/

/* ------------------------------------------------------------------ */
/*                          EMPTY RESPONSE                            */
/* ------------------------------------------------------------------ */
function getEmptyResponse() {
  return {
    task_name: "", category: "", due_date: "", frequency: "",
    reminder_time: "12:00", person_name: "", person_role: ""
  };
}
