// Helper: obtiene token de autenticación de Tilopay API v1
// Usado por tilopay-pay.js y tilopay-split.js

const TILOPAY_API = 'https://app.tilopay.com/api/v1';

export async function getTilopayToken() {
  // Intentar con los campos correctos según doc Tilopay loginSdk
  const body = {
    apiuser: process.env.TILOPAY_USER,   // 8NKGva
    password: process.env.TILOPAY_PASS,  // 6eS0YQ
    key: process.env.TILOPAY_KEY         // 6279-2348-1294-3938-1069
  };

  const res = await fetch(`${TILOPAY_API}/loginSdk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  console.log('loginSdk status:', res.status, 'body:', text.substring(0, 200));
  let data;
  try { data = JSON.parse(text); } catch(e) { throw new Error('Tilopay respuesta inválida: ' + text); }

  if (!data.access_token) throw new Error('No se pudo autenticar con Tilopay: ' + JSON.stringify(data));
  console.log('Token OK, longitud:', data.access_token.length);
  return data.access_token;
}

export { TILOPAY_API };
