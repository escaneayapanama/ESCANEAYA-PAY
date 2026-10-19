// Endpoint: hace el split de la liquidación entre negocio y EscaneaYa Pay
// Llamado desde pago-resultado.html cuando el pago es aprobado
// POST /api/tilopay-split
// Body: { orderId, negocioEmail, montoNegocio, orderNumber, returnData }

import { getTilopayToken, TILOPAY_API } from './tilopay-auth.js';

const ESCANEAYA_EMAIL = 'soporte@escaneayapay.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { orderId, negocioEmail, montoNegocio, orderNumber, returnData } = req.body;

    if (!orderId || !negocioEmail || !montoNegocio) {
      return res.status(400).json({ ok: false, error: 'Faltan parámetros: orderId, negocioEmail, montoNegocio' });
    }

    const token = await getTilopayToken();

    // Hacer el split: negocio recibe su parte, EscaneaYa se queda el resto
    const splitRes = await fetch(`${TILOPAY_API}/orders/liquidation/split`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        order_id: orderId,
        commerces: [
          {
            email: negocioEmail,
            amount: parseFloat(montoNegocio).toFixed(2)
          }
          // EscaneaYa (soporte@escaneayapay.com) recibe el excedente automáticamente
          // según la documentación de Tilopay: "el restante se le asigna al comercio original"
        ],
        lang: 'es'
      })
    });

    const splitData = await splitRes.json();

    if (splitData.type !== '200') {
      console.error('Split error:', splitData);
      return res.status(500).json({ ok: false, error: 'Error en split', detail: splitData });
    }

    // Decodificar returnData para obtener info completa de la transacción
    let txInfo = {};
    try {
      txInfo = JSON.parse(Buffer.from(returnData || '', 'base64').toString('utf8'));
    } catch(e) {}

    // Registrar transacción en Google Sheets via proxy eyp
    try {
      const registroRes = await fetch(`https://${process.env.APP_URL}/api/eyp?action=guardarTransaccion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          negocioEmail,
          orderNumber: orderNumber || txInfo.orderNumber,
          orderId,
          montoTotal: txInfo.montoTotal,
          comisionEYP: txInfo.comisionEYP,
          montoNegocio: txInfo.montoNegocio,
          estado: 'aprobado',
          fecha: new Date().toISOString()
        })
      });
    } catch(e) {
      console.log('Registro en Sheets falló (no crítico):', e.message);
    }

    return res.status(200).json({
      ok: true,
      message: 'Split realizado correctamente',
      split: splitData.response
    });

  } catch (err) {
    console.error('tilopay-split error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
