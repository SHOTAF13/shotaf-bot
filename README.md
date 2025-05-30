# 🤖 Shotaf Bot

**Shotaf Bot** הוא בוט WhatsApp אוטומטי שמתרגם הודעות בעברית לפעולות לביצוע ומוסיף אותן כמשימות בגיליון Google Sheets.

## ✨ מה הבוט יודע לעשות

- מקבל הודעות בעברית דרך WhatsApp
- מנתח את ההודעה עם GPT-4 ומזהה:
  - שם המשימה
  - קטגוריה (משפחה, רכב, עבודה וכו’)
  - תאריך יעד מדויק
  - תדירות (שבועי, חודשי, שנתי וכו’)
- שומר את כל המידע בגיליון Google Sheets

## 🛠 טכנולוגיות בשימוש

- Node.js
- Twilio WhatsApp Sandbox
- OpenAI GPT-4 API
- Google Sheets API
- Ngrok (לחשיפת localhost)

## 📦 התקנה מקומית

```bash
npm install
npm run dev
