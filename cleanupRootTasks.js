import dotenv from 'dotenv';
import { db }  from './firebase.js';

dotenv.config();

async function deleteRootTasks() {
  console.log('🔄 מתחיל למחוק את כל המסמכים ב־tasks (root)...');
  const snap = await db.collection('tasks').get();

  if (snap.empty) {
    console.log('✅ אין מסמכים ב־tasks (root) – לא צריך למחוק כלום.');
    return;
  }

  for (const doc of snap.docs) {
    console.log('🗑️ מוחק root task:', doc.id);
    await doc.ref.delete();
  }

  console.log('🎉 הסתיימה המחיקה של', snap.docs.length, 'מסמכים.');
}

deleteRootTasks()
  .catch(err => {
    console.error('‼️ שגיאה במחיקת מסמכים:', err);
    process.exit(1);
  })
  .then(() => process.exit(0));
