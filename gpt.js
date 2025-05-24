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

אתה מקבל הודעה חופשית שכתובה בעברית.  
המטרה שלך היא לנתח את ההודעה ולהחזיר מידע במבנה JSON מדויק עם ארבעה שדות בלבד:

1. task_name – ניסוח קצר וברור של המשימה שצריך לבצע.
2. category – אחת מהקטגוריות: משפחה, זוגיות, עבודה, בריאות, חברים, רכב, לימודים, קניות, כללי.
3. due_date – תאריך היעד (בפורמט YYYY-MM-DD). אם מופיע תאריך יחסי כמו "שבוע הבא ביום ראשון", חשב את התאריך לפי היום הנוכחי.
4. frequency – אם נכתב במפורש או ניתן להבין תדירות, החזר: יומי / שבועי / חודשי / שנתי / חד פעמי

📅 היום הנוכחי הוא: ${today}
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
    return { task_name: '', category: '', due_date: '', frequency: '' };
  }
}
