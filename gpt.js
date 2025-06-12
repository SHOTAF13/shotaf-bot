/* ------------------------------------------------------------------ */
/*                               IMPORTS                              */
/* ------------------------------------------------------------------ */
import dotenv          from 'dotenv';
import OpenAI          from 'openai';
import { db }          from './firebase.js';
import { updateUserMemory } from './updateUserMemory.js';
import { getTopK }         from './searchSimilar.js';

dotenv.config();
export const openai = new OpenAI({ apiKey: process.env.KEY_GPT });

/* ------------------------------------------------------------------ */
/*                         GLOBAL CONSTANTS                           */
/* ------------------------------------------------------------------ */
const HEBREW_DAYS = [
  'יום ראשון', 'יום שני', 'יום שלישי',
  'יום רביעי', 'יום חמישי', 'יום שישי', 'יום שבת'
];

/* ------------------------------------------------------------------ */
/*                            GPT SCHEMA                              */
/* ------------------------------------------------------------------ */
export const analyzeSchema = {
  name: 'analyze_message',
  description: 'סיווג הודעה מהמשתמש לשותף האישי',
  parameters: {
    type: 'object',
    properties: {
      entry_type   : { enum: ['task', 'note'], description: 'task = משימה, note = פתק' },
      task_name    : { type: 'string', description: 'שם המשימה (אם task)' },
      category     : { type: 'string' },
      due_date     : { type: 'string', description: 'YYYY-MM-DD או ריק' },
      frequency    : { type: 'string' },
      reminder_time: { type: 'string' },
      note_title   : { type: 'string' },
      note_body    : { type: 'string' },
      person_name  : { type: 'string' },
      person_role  : { type: 'string' }
    },
    required: ['entry_type']
  }
};
/* ------------------------------------------------------------------ */
/*                  Modify-Task Function Schema                       */
/* ------------------------------------------------------------------ */
export const modifyTaskSchema = {
  name: 'modify_task',
  description: 'משנה פרטי משימה קיימת לפי הודעה חדשה של המשתמש',
  parameters: {
    type: 'object',
    properties: {
      task_name: {
        type       : 'string',
        description: 'שם משימה חדש, אם שונה'
      },
      due_date: {
        type       : 'string',
        format     : 'date',
        description: 'תאריך יעד חדש (YYYY-MM-DD)'
      },
      reminder_time: {
        type       : 'string',
        pattern    : '^\\d{2}:\\d{2}$',
        description: 'שעת תזכורת HH:mm מעודכנת'
      },
      category: {
        type       : 'string',
        description: 'קטגוריה חדשה למשימה'
      },
      frequency: {
        type       : 'string',
        description: 'תדירות חדשה: "יומי", "שבועי"…'
      },
      person_name: {
        type       : 'string',
        description: 'שם אדם משויך, אם השתנה'
      },
      person_role: {
        type       : 'string',
        description: 'תפקיד/קשר משויך, אם השתנה'
      }
    },
    required: []          // המודל יחזיר רק את מה ששונה
  }
};


/* ------------------------------------------------------------------ */
/*                       SIMPLE HELPER FUNCTIONS                      */
/* ------------------------------------------------------------------ */
export function parseFrequency(txt) {
  if (/כל יום/i.test(txt))                                return 'יומי';
  if (/פעמיים בשבוע|כל.*שבוע/i.test(txt))                return 'שבועי';
  if (/כל יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/i) return 'שבועי';
  if (/כל חודש|חודשי/i.test(txt))                        return 'חודשי';
  return '';
}

export function extractTimeFromText(txt) {
  const m = txt.match(/\b(0?[0-9]|1[0-9]|2[0-3]):([0-5][0-9])\b/);
  if (m) return m[0];
  if (txt.includes('בערב'))    return '20:00';
  if (txt.includes('בבוקר'))   return '08:00';
  if (txt.includes('בצהריים')) return '13:00';
  if (txt.includes('אחה'))     return '17:00'; // אחה"צ
  return '12:00';
}

/* ------------------------------------------------------------------ */
/*                NEW: formatDocForPrompt (context helper)            */
/* ------------------------------------------------------------------ */
export async function formatDocForPrompt(doc_id) {
  /* ----- 1) ננסה באוסף entries ----- */
  let snap = await db.collection('entries').doc(doc_id).get();
  if (snap.exists) {
    const { entry_type, title = '', body = '', url = '' } = snap.data();

    if (entry_type === 'note') {
      const firstLine = body.split(/\r?\n/)[0].slice(0, 80);
      return `פתק: "${title}" – ${firstLine}`;
    }
    if (entry_type === 'file') {
      return `קובץ: "${title}" – ${url}`;
    }
  }

  /* ----- 2) אולי זה task בתת-אוסף user_tasks ----- */
  snap = await db.collectionGroup('user_tasks')
                 .where('task_id', '==', doc_id)
                 .limit(1).get();
  if (!snap.empty) {
    const t = snap.docs[0].data();
    return `משימה: "${t.task_name}" – יעד ${t.due_date || 'ללא תאריך'}`;
  }

  return '';          // fallback – לא מצאנו כלום
}

/* ------------------------------------------------------------------ */
/*                   MAIN: analyzeMessageWithGPT                      */
/* ------------------------------------------------------------------ */
export async function analyzeMessageWithGPT(message, userId = null) {
  /* ---------- 1) קונטקסט דומה ---------- */
  const hits = await getTopK(userId, message);

  const contextArr = await Promise.all(
    hits
      .filter(h => h.score > 0.6)
      .map(h => formatDocForPrompt(h.doc_id))
  );
  const context = contextArr.filter(Boolean).join('\n\n---\n\n');

  /* ---------- 2) פרופיל/תאריך ---------- */
  const mem          = userId ? await loadUserMemory(userId) : {};
  const profileText  = JSON.stringify(mem.profile || {});
  const now          = new Date();
  const todayISO     = now.toISOString().split('T')[0];
  const todayNameHeb = HEBREW_DAYS[now.getDay()];

  const messages = [
    {
    role: 'system',
    content:
`היום הוא ${todayNameHeb}, התאריך ${todayISO}.
פרופיל משתמש: ${profileText}

אתה עוזר אישי.
החזר JSON לפי הסכמה:  task  או  note  בלבד.
אם ההודעה אינה מתארת משימה/פתק – החזר {"entry_type":""}.`
  },
  { role: 'user', content: message }
];

  /* ---------- 3) קריאה ל-GPT ---------- */
  let gptData;
  try {
    const completion = await openai.chat.completions.create({
      model        : 'gpt-4o-mini',
      messages,
      functions    : [analyzeSchema],
      function_call: { name: 'analyze_message' }
    });

    gptData = JSON.parse(
      completion.choices[0].message.function_call.arguments
    );
  } catch (err) {
    console.error('❌ GPT function-call failed:', err);
    return getEmptyResponse();
  }

  /* ---------- 4) השלמות צד-שרת ---------- */
  gptData.frequency     ||= parseFrequency(message);
  gptData.reminder_time ||= extractTimeFromText(message);

  if (gptData.entry_type === 'note' &&
      !gptData.note_title &&
      gptData.note_body) {
    gptData.note_title = gptData.note_body.slice(0, 40);
  }

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
      ...(gptData.category && { topics: [gptData.category] })
    };

    if (Object.keys(newProfile).length) {
      console.log('🧠 Updating user profile with:', newProfile);
      await updateUserMemory(userId, { profile: newProfile });
    }
  }

  return gptData;
}

/* ------------------------------------------------------------------ */
/*                REMAINING UTILITY / EXPORT FUNCTIONS                */
/* ------------------------------------------------------------------ */
export async function loadUserMemory(userId) {
  const doc = await db.collection('user_memory').doc(userId).get();
  return doc.exists ? doc.data() : {};
}

/* ------------------- LEGACY / UNUSED (כבויים) -------------------- */
/*  חלקים ישנים נשארים בהערות למקרה שתצטרך לשחזר                    */
/*  …                                                                 */

/* ------------------------------------------------------------------ */
/*                          EMPTY RESPONSE                            */
/* ------------------------------------------------------------------ */
function getEmptyResponse() {
  return {
    task_name: '', category: '', due_date: '', frequency: '',
    reminder_time: '12:00', person_name: '', person_role: ''
  };
}
