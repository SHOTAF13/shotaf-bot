import { loadUserMemory } from './updateUserMemory.js';

export async function generateAnswerFromUserMemory(userId, message) {
  const memory = await loadUserMemory(userId);

  if (!memory || !memory.memory || !memory.memory.names) {
    return "אין לי עדיין מידע על אנשים שהזכרת.";
  }

  const mentioned = Object.keys(memory.memory.names).filter(name => message.includes(name));

  if (mentioned.length === 0) {
    return "לא מצאתי מידע על האדם שהזכרת.";
  }

  const results = mentioned.map(name => {
    const person = memory.memory.names[name];
    const role = person.role || 'לא צוין תפקיד';
    const tags = person.tags?.join(', ') || 'בלי משימות קודמות';
    const last = person.last_used || 'תאריך לא ידוע';

    return `🧠 עם ${name} (${role}): עשית ${tags}. לאחרונה ב־${last}.`;
  });

  return results.join('\n');
}
