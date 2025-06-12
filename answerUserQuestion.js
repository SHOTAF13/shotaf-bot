import { db } from './firebase.js';
import { findBestNoteMatch } from './utils/search.js';


// ----- 🔍 נסה למצוא פתק מתאים לפני GPT -----
  const best = await findBestNoteMatch(question, userId);
  
  if (best){
    // ① שולחים את הפתק כרקע ל-GPT ומקבלים תשובה נחמדה
    const chat = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages:[
        { role:'system', content:'אתה שותף דיגיטלי שעונה בעברית קלילה ותמציתית.' },
        { role:'user',
          content:
`השאלה שלי: "${question}"

להלן מידע רלוונטי מהפתק שלי:
כותרת: ${best.title}
תוכן: ${best.body}

ענה לי בעברית ידידותית (בלי להזכיר "פתק" או "המסמך").` }
      ]
    });

    return chat.choices[0].message.content.trim();
  }


export async function answerUserQuestionWithGPT(userId, newInfo = {}) {
  // הגנה מפני null
  newInfo = newInfo || {};
  }

  const userRef = db.collection('user_memory').doc(userId);
  const doc = await userRef.get();

  let memoryData = {
    user_id: userId,
    memory: {
      names: {},
      keywords: {},
      topics: []
    }
  };

  if (doc.exists) {
    memoryData = doc.data();
  }

  // ✅ עיבוד שם האדם
  if (newInfo.name && typeof newInfo.name === 'string') {
    const existing = memoryData.memory.names?.[newInfo.name] || {
      mentions: 0,
      tags: [],
      role: '',
      last_used: ''
    };

     memoryData.memory.contacts ||= {};
    memoryData.memory.contacts[newInfo.name] = {
     role: newInfo.role || existing.role,
   
 
      role: newInfo.role || existing.role,
      mentions: existing.mentions + 1,
      tags: Array.from(new Set([...(existing.tags || []), ...(newInfo.tags || [])])),
      last_used: new Date().toISOString().split('T')[0]
    };
  }

  // ✅ מילות מפתח
  if (newInfo.keywords && typeof newInfo.keywords === 'object') {
    for (const [keyword, meaning] of Object.entries(newInfo.keywords)) {
      memoryData.memory.keywords[keyword] = meaning;
    }
  }

  // ✅ נושאים
  if (Array.isArray(newInfo.topics)) {
    memoryData.memory.topics = Array.from(
      new Set([...(memoryData.memory.topics || []), ...newInfo.topics])
    );
  }

  await userRef.set(memoryData);
  console.log(`✅ זיכרון עודכן עבור ${userId}`);

