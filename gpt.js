require("dotenv").config();
const OpenAI = require("openai");
console.log("🔑 API:", process.env.OPENAI_API_KEY);

const openai = new OpenAI({
  apiKey: process.env.KEY_GPT,
});

async function analyzeMessageWithGPT(message) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const prompt = `
הודעה: "${message}"

אתה מקבל הודעה חופשית שכתובה בעברית.  
המטרה שלך היא לנתח את ההודעה ולהחזיר מידע במבנה JSON מדויק עם ארבעה שדות בלבד:

1. task_name – ניסוח קצר וברור של המשימה שצריך לבצע.
2. category – אחת מהקטגוריות: משפחה, זוגיות, עבודה, בריאות, חברים, רכב, לימודים, קניות, כללי.
3. due_date – תאריך היעד (בפורמט YYYY-MM-DD). אם מופיע תאריך יחסי כמו "שבוע הבא ביום ראשון", חשב את התאריך לפי היום הנוכחי.
4. frequency – אם נכתב במפורש או ניתן להבין תדירות (כמו כל שבוע, כל שנה וכו'), החזר:
   - "יומי" אם זה כל יום.
   - "שבועי" אם זה פעם בשבוע.
   - "חודשי" אם זה פעם בחודש.
   - "שנתי" אם זה נוגע ליום הולדת או אירוע שנתי.
   - "חד פעמי" אם אין תדירות.

📌 חשוב מאוד:
- אם חסר מידע או לא ברור מה המשימה – רשום "לא זוהה" או שייך לקטגוריה "כללי".
- אל תוסיף שום הסבר. החזר רק את ה־JSON.

📅 היום הנוכחי הוא: ${today}  
השתמש בזה כדי לחשב תאריכים כמו "שבוע הבא", "ביום ראשון", "בעוד שבועיים" וכו'.
  `;

  const completion = await openai.chat.completions.create({
    model: "gpt-4",
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
      frequency: ''
    };
  }
}


module.exports = { analyzeMessageWithGPT };
