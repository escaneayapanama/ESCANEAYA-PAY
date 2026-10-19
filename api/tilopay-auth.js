// Helper: obtiene token de autenticación de Tilopay API v1
// Usado por tilopay-pay.js y tilopay-split.js

const TILOPAY_API = 'https://app.tilopay.com/api/v1';
export const TILOPAY_PAYMENT_API = 'https://app.tilopay.com/api/v1'; // mismo host, confirmado

// Token para Hosted Payment Page (processPayment) — usa /api/v1/login
export async function getTilopayToken() {
  const res = await fetch(`${TILOPAY_API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiuser: process.env.TILOPAY_USER,  // 8NKGva
      password: process.env.TILOPAY_PASS  // 6eS0YQ
    })
  });

  const text = await res.text();
  console.log('login status:', res.status, 'body:', text.substring(0, 200));
  let data;
  try { data = JSON.parse(text); } catch(e) { throw new Error('Tilopay respuesta inválida: ' + text); }

  if (!data.access_token) throw new Error('No se pudo autenticar con Tilopay: ' + JSON.stringify(data));
  console.log('Token OK, longitud:', data.access_token.length);
  return data.access_token;
}

// Token para SDK (loginSdk) — por si se necesita en el futuro
export async function getTilopayTokenSdk() {
  const res = await fetch(`${TILOPAY_API}/loginSdk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiuser: process.env.TILOPAY_USER,
      password: process.env.TILOPAY_PASS,
      key: process.env.TILOPAY_KEY
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('loginSdk falló: ' + JSON.stringify(data));
  return data.access_token;
}

export { TILOPAY_API };
