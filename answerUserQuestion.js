import { db } from './firebase.js';

export async function answerUserQuestionWithGPT(userId, newInfo = {}) {
  // הגנה מפני null
  newInfo = newInfo || {};

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

    memoryData.memory.names[newInfo.name] = {
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
}
