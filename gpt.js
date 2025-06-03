import OpenAI from 'openai';
import dotenv from 'dotenv';
import { db } from './firebase.js';
import { updateUserMemory } from './updateUserMemory.js';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.KEY_GPT,
});

const daysMap = {
  'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3,
  'Thursday': 4, 'Friday': 5, 'Saturday': 6,
  'יום ראשון': 0, 'יום שני': 1, 'יום שלישי': 2,
  'יום רביעי': 3, 'יום חמישי': 4, 'יום שישי': 5, 'יום שבת': 6
};

function parseHebrewDate(text) {
  const today = new Date();
  const lowerText = text.toLowerCase();

  if (lowerText.includes('היום')) {
    return today.toISOString().split('T')[0];
  }

  if (lowerText.includes('מחר')) {
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }

  for (const [label, targetDay] of Object.entries(daysMap)) {
    if (text.includes(label)) {
      const currentDay = today.getDay();
      let daysUntil = (targetDay - currentDay + 7) % 7;
      if (daysUntil === 0) daysUntil = 7;
      const result = new Date(today);
      result.setDate(today.getDate() + daysUntil);
      return result.toISOString().split('T')[0];
    }
  }

  return '';
}

function extractTimeFromText(text) {
  const timeMatch = text.match(/\b(0?[0-9]|1[0-9]|2[0-3]):([0-5][0-9])\b/);
  if (timeMatch) return timeMatch[0];

  if (text.includes('בערב')) return '20:00';
  if (text.includes('בבוקר')) return '08:00';
  if (text.includes('בצהריים')) return '13:00';
  if (text.includes('אחה"צ') || text.includes('אחר הצהריים')) return '17:00';

  return '12:00';
}

export async function analyzeMessageWithGPT(message, userId = null) {
  const today = new Date().toISOString().split('T')[0];

  const prompt = `
Analyze the following message in Hebrew and return a valid JSON with 7 fields:

Message: "${message}"

Return these keys:
1. task_name – Short task summary
2. category – One of: משפחה, זוגיות, עבודה, בריאות, חברים, רכב, לימודים, קניות, כללי
3. due_date – Date in YYYY-MM-DD (assume "היום" is ${today})
4. frequency – יומי, שבועי, חודשי, שנתי, חד פעמי (default: חד פעמי)
5. reminder_time – Time in HH:MM (default: 12:00)
6. person_name – A name mentioned (e.g., שובל)
7. person_role – If possible, the relation (e.g., חברה, קולגה)

Return only valid JSON – no comments or explanations.
🗣 All fields must be in **Hebrew**.
`.trim();

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-nano-2025-04-14",
      messages: [{ role: "user", content: prompt }],
    });

    const responseText = completion.choices[0]?.message?.content || '';
    console.log("📤 GPT Response:", responseText);

    const cleanedResponse = responseText.trim().replace(/^```(json)?|```$/g, '');
    const parsed = JSON.parse(cleanedResponse);

    const parsedDate = parseHebrewDate(message);
    if (parsedDate) parsed.due_date = parsedDate;
    parsed.reminder_time = extractTimeFromText(message);

    if (userId) {
      const newMemory = {
        name: parsed.person_name,
        role: parsed.person_role,
        tags: [parsed.task_name],
        keywords: { [parsed.task_name]: parsed.category },
        topics: [parsed.category]
      };

      if (parsed.person_name) {
        newMemory.name = parsed.person_name;
        newMemory.role = parsed.person_role;
      }

      console.log("🧠 Updating user memory with:", newMemory);
      await updateUserMemory(userId, newMemory);
    }

    return parsed;
  } catch (err) {
    console.error("❌ Failed to parse GPT response:", err.message || err);
    return getEmptyResponse();
  }
}

export async function loadUserMemory(userId) {
  const doc = await db.collection('user_memory').doc(userId).get();
  return doc.exists ? doc.data() : {};
}

export async function answerUserQuestionWithGPT(question, memory, userId = null) {
  const memorySummary = JSON.stringify(memory, null, 2);

  const prompt = `
המשתמש שואל: "${question}"

להלן מידע על מה שאתה יודע עליו:
${memorySummary}

ענה בעברית ובצורה ברורה בקצרה על פי המידע הקיים. אם אין מידע רלוונטי, אמור "לא מצאתי מידע מתאים".
`.trim();

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-nano-2025-04-14",
      messages: [{ role: "user", content: prompt }],
    });

    const reply = completion.choices[0]?.message?.content || 'לא מצאתי מידע.';
    return reply;
  } catch (err) {
    console.error("❌ שגיאה בתשובת GPT:", err.message || err);
    return 'הייתה שגיאה בעיבוד השאלה שלך.';
  }
}

function getEmptyResponse() {
  return {
    task_name: '',
    category: '',
    due_date: '',
    frequency: '',
    reminder_time: '12:00',
    person_name: '',
    person_role: ''
  };
}
