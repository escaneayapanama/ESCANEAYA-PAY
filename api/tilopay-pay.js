// Endpoint: genera URL de pago de Tilopay para un negocio
// POST /api/tilopay-pay
// Body: { amount, negocioEmail, negocioNombre, orderNumber }

import { getTilopayToken, TILOPAY_API } from './tilopay-auth.js';

// Comisiones EscaneaYa Pay por tarjeta
const COMISION_PORCENTAJE = 0.055;  // 5.5%
const COMISION_FIJA = 0.75;         // $0.75 por transacción

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { amount, negocioEmail, negocioNombre, orderNumber } = req.body;

    if (!amount || !negocioEmail || !orderNumber) {
      return res.status(400).json({ ok: false, error: 'Faltan parámetros: amount, negocioEmail, orderNumber' });
    }

    const montoTotal = parseFloat(amount);
    if (isNaN(montoTotal) || montoTotal <= 0) {
      return res.status(400).json({ ok: false, error: 'Monto inválido' });
    }

    // Calcular comisión EscaneaYa que se descontará al negocio
    const comisionEYP = parseFloat((montoTotal * COMISION_PORCENTAJE + COMISION_FIJA).toFixed(2));
    const montoNegocio = parseFloat((montoTotal - comisionEYP).toFixed(2));

    // Obtener token de Tilopay
    const token = await getTilopayToken();

    // Crear URL de pago en Tilopay
    const payRes = await fetch(`${TILOPAY_API}/processPayment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        redirect: `${process.env.APP_URL}/pago-resultado.html`,
        key: process.env.TILOPAY_KEY,
        amount: montoTotal.toFixed(2),
        currency: 'USD',
        orderNumber: orderNumber,
        capture: '1',
        billToFirstName: 'Cliente',
        billToLastName: 'EscaneaYa',
        billToAddress: 'Panama',
        billToAddress2: 'Panama',
        billToCity: 'Panama',
        billToState: 'PA-8',
        billToZipPostCode: '0801',
        billToCountry: 'PA',
        billToTelephone: '00000000',
        billToEmail: 'cliente@escaneayapay.com',
        shipToFirstName: 'Cliente',
        shipToLastName: 'EscaneaYa',
        shipToAddress: 'Panama',
        shipToAddress2: 'Panama',
        shipToCity: 'Panama',
        shipToState: 'PA-8',
        shipToZipPostCode: '0801',
        shipToCountry: 'PA',
        shipToTelephone: '00000000',
        subscription: '0',
        platform: 'EscaneaYaPay',
        returnData: Buffer.from(JSON.stringify({
          negocioEmail,
          negocioNombre,
          montoTotal,
          comisionEYP,
          montoNegocio,
          orderNumber
        })).toString('base64'),
        hashVersion: 'V2',
        token_version: 'v2'
      })
    });

    const payData = await payRes.json();

    if (!payData.url) {
      console.error('Tilopay error:', payData);
      return res.status(500).json({ ok: false, error: 'Tilopay no devolvió URL', detail: payData });
    }

    return res.status(200).json({
      ok: true,
      url: payData.url,
      orderNumber,
      montoTotal,
      comisionEYP,
      montoNegocio
    });

  } catch (err) {
    console.error('tilopay-pay error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
