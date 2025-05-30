import fs from 'fs';
import path from 'path';

const MEMORY_DIR = './memory';

export function loadUserMemory(userId) {
  const filePath = path.join(MEMORY_DIR, `user_${userId}.json`);

  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      console.warn(`⚠️ לא הצלחתי לקרוא את הזיכרון של user_${userId}:`, err.message);
    }
  }

  return {}; // אם לא קיים קובץ זיכרון, מחזירים אובייקט ריק
}
