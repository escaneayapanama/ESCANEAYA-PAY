// Vercel serverless — envía notificación push FCM a un negocio
// Llamado desde Google Apps Script cuando llega un pago o liquidación

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // Validar secreto para que solo Apps Script pueda llamar este endpoint
  const auth = req.headers['authorization'] || '';
  if (auth !== 'Bearer ' + process.env.NOTIFY_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const { token, title, body, data } = req.body;

    if (!token || !title) {
      return res.status(400).json({ ok: false, error: 'token y title son requeridos' });
    }

    // Llamar a FCM v1 API
    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/messages:send`;

    const message = {
      message: {
        token: token,
        notification: { title, body: body || '' },
        data: data || {},
        android: {
          priority: 'high',
          notification: { sound: 'default', channel_id: 'escaneaya_pay' }
        },
        apns: {
          payload: { aps: { sound: 'default', badge: 1 } }
        }
      }
    };

    const fcmRes = await fetch(fcmUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.FIREBASE_ACCESS_TOKEN
      },
      body: JSON.stringify(message)
    });

    const fcmData = await fcmRes.json();

    if (!fcmRes.ok) {
      console.error('FCM error:', fcmData);
      return res.status(500).json({ ok: false, error: 'FCM error', detail: fcmData });
    }

    return res.status(200).json({ ok: true, messageId: fcmData.name });

  } catch (err) {
    console.error('notify error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
