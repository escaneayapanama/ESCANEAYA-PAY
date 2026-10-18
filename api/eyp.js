// Proxy para Google Apps Script — evita bloqueos CORS/CSP en iOS PWA
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwbBiewEUY3M-OmZIpE-4MYQCxzOVAYARL22Xi7kuGUQrtadZt5MEcs1-DG5S_yigp7/exec";

export default async function handler(req, res) {
  // CORS para que el dashboard pueda llamar desde cualquier origen
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Tomar todos los query params y pasarlos a Apps Script
  const params = new URLSearchParams(req.query);
  const url = `${APPS_SCRIPT_URL}?${params.toString()}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'EscaneaYaProxy/1.0'
      },
      redirect: 'follow'
    });

    const text = await response.text();

    // Si piden JSONP (tienen callback), devolver JS
    const callback = req.query.callback;
    if (callback) {
      res.setHeader('Content-Type', 'application/javascript');
      // Apps Script ya devuelve callback(data), pasarlo directo
      return res.status(200).send(text);
    }

    // Si no, devolver JSON
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(text);
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ ok: false, error: 'Proxy error: ' + err.message });
  }
}
