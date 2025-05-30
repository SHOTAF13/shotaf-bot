import OpenAI from 'openai';
import dotenv from 'dotenv';
import { updateUserMemory } from './updateUserMemory.js';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.KEY_GPT,
});

const daysMap = {
  'יום ראשון': 0,
  'יום שני': 1,
  'יום שלישי': 2,
  'יום רביעי': 3,
  'יום חמישי': 4,
  'יום שישי': 5,
  'יום שבת': 6,
};

// זיהוי תאריך הבא של יום בשבוע שמוזכר בטקסט
function parseHebrewWeekdayToDate(text) {
  for (const [label, targetDay] of Object.entries(daysMap)) {
    if (text.includes(label)) {
      const today = new Date();
      const currentDay = today.getDay();
      let daysUntil = (targetDay - currentDay + 7) % 7;
      if (daysUntil === 0) daysUntil = 7; // תמיד קובע לשבוע הבא אם היום זה אותו יום
      const result = new Date(today);
      result.setDate(today.getDate() + daysUntil);
      return result.toISOString().split('T')[0];
    }
  }
  return '';
}

export async function analyzeMessageWithGPT(message, userId = null) {
  const today = new Date().toISOString().split('T')[0];

  const prompt = `
הודעה: "${message}"

המטרה שלך היא לנתח את ההודעה החופשית בעברית, ולהחזיר מידע במבנה JSON מדויק עם חמישה שדות בלבד:

1. task_name – ניסוח קצר של המשימה.
2. category – אחת בלבד מתוך: משפחה, זוגיות, עבודה, בריאות, חברים, רכב, לימודים, קניות, כללי. אם לא ברור – החזר "כללי".
3. due_date – תאריך היעד בפורמט YYYY-MM-DD. אם לא ברור – השאר ריק.
4. frequency – תדירות: יומי / שבועי / חודשי / שנתי / חד פעמי. אם לא ברור – החזר "חד פעמי".
5. reminder_time – שעת התזכורת בפורמט HH:MM, לפי ההקשר (למשל "בבוקר" = 09:00, "בערב" = 19:00). אם לא ברור – ברירת מחדל 12:00.

📅 היום הנוכחי הוא: ${today}
אם כתוב "היום", התייחס ל־${today} כתאריך.

🔒 החזר אך ורק JSON חוקי – ללא טקסט נוסף, כותרות או הסברים.
✅ הפלט חייב להיות מוכן ל־JSON.parse.

דוגמה:
{
  "task_name": "לקחת את הילד לרופא",
  "category": "משפחה",
  "due_date": "2025-05-28",
  "frequency": "חד פעמי",
  "reminder_time": "09:00"
}`.trim();

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-nano-2025-04-14",
      messages: [{ role: "user", content: prompt }],
    });

    const responseText = completion.choices[0]?.message?.content || '';
    console.log("📤 תגובת GPT:", responseText);

    try {
      const parsed = JSON.parse(responseText);

      // אם מופיע יום בשבוע, נעדכן את התאריך
      const weekdayDate = parseHebrewWeekdayToDate(message);
      if (weekdayDate) parsed.due_date = weekdayDate;

      // אם יש מזהה משתמש – נעדכן את הזיכרון שלו
      if (userId) {
        await updateUserMemory(userId, {
          contextSamples: [message],
          lastTask: parsed.task_name,
          lastCategory: parsed.category
        });
      }

      return parsed;
    } catch (err) {
      console.error("❌ לא הצלחתי לפרש את תגובת GPT כ־JSON:", responseText);
      return getEmptyResponse();
    }
  } catch (err) {
    console.error("❌ קרסה הקריאה ל־GPT:", err.message || err);
    return getEmptyResponse();
  }
}

function getEmptyResponse() {
  return {
    task_name: '',
    category: '',
    due_date: '',
    frequency: '',
    reminder_time: '12:00'
  };
}
