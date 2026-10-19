// Helper: obtiene token de autenticación de Tilopay API v1
// Usado por tilopay-pay.js y tilopay-split.js

const TILOPAY_API = 'https://app.tilopay.com/api/v1';

export async function getTilopayToken() {
  const res = await fetch(`${TILOPAY_API}/loginSdk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.TILOPAY_USER,       // 8NKGva  (usuario API)
      password: process.env.TILOPAY_PASS,    // 6eS0YQ  (contraseña API)
      key: process.env.TILOPAY_KEY           // 6279-2348-1294-3938-1069
    })
  });
  const data = await res.json();
  if (!data.token) throw new Error('No se pudo autenticar con Tilopay: ' + JSON.stringify(data));
  return data.token;
}

export { TILOPAY_API };
