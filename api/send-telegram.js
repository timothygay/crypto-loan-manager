// api/send-telegram.js
// Vercel Serverless Function for Telegram Alerts

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Handle OPTIONS request (CORS preflight)
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { botToken, chatId, message } = req.body;

    // Validate inputs
    if (!botToken || !chatId || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: botToken, chatId, or message' 
      });
    }

    // Send to Telegram
    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    const telegramResponse = await fetch(telegramUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });

    const telegramData = await telegramResponse.json();

    if (telegramData.ok) {
      return res.status(200).json({ 
        success: true,
        message_id: telegramData.result.message_id
      });
    } else {
      return res.status(400).json({ 
        success: false, 
        error: `Telegram API error: ${telegramData.description}` 
      });
    }
  } catch (error) {
    console.error('Error sending Telegram message:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
