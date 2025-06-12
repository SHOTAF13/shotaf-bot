// whatsapp.js
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const BASE_URL = 'https://7105.api.greenapi.com';
const { BOT_ID_INSTANCE, BOT_TOKEN } = process.env;

export async function sendWhatsappMessage(chatId, message) {
  try {
    await axios.post(
      `${BASE_URL}/waInstance${BOT_ID_INSTANCE}/sendMessage/${BOT_TOKEN}`,
      { chatId, message }
    );
    console.log('📤 הודעה נשלחה אל', chatId);
  } catch (err) {
    console.error('❌ WhatsApp send error:', err.response?.data || err.message);
  }
}
