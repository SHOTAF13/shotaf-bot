import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.KEY_GPT,
});

export async function analyzeMessageWithGPT(message) {
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

🔒 החזר אך ורק JSON חוקי – ללא טקסט נוסף, כותרות או הסברים.
✅ הפלט חייב להיות מוכן ל־JSON.parse.

דוגמה:
{
  "task_name": "לקחת את הילד לרופא",
  "category": "משפחה",
  "due_date": "2025-05-28",
  "frequency": "חד פעמי",
  "reminder_time": "09:00"
}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: prompt }],
  });

  const responseText = completion.choices[0].message.content;

  try {
    return JSON.parse(responseText);
  } catch (err) {
    console.error("❌ לא הצלחתי לפרש את תגובת GPT:", responseText);
    return {
      task_name: '',
      category: '',
      due_date: '',
      frequency: '',
      reminder_time: '12:00'
    };
  }
}
