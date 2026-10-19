// Proxy para Google Apps Script — evita bloqueos CORS/CSP en iOS PWA
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwbBiewEUY3M-OmZIpE-4MYQCxzOVAYARL22Xi7kuGUQrtadZt5MEcs1-DG5S_yigp7/exec";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Quitar callback si viene del dashboard (no necesitamos JSONP desde el servidor)
    const params = { ...req.query };
    delete params.callback;

    const qs = new URLSearchParams(params).toString();
    const url = `${APPS_SCRIPT_URL}?${qs}`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'EscaneaYaProxy/1.0' },
      redirect: 'follow'
    });

    const text = await response.text();

    // Apps Script puede devolver JSONP: cb({...}) — extraer solo el JSON
    let json = text;
    const jsonpMatch = text.match(/^[^(]+\((.+)\)\s*;?\s*$/s);
    if (jsonpMatch) json = jsonpMatch[1];

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(json);
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Proxy error: ' + err.message });
  }
}
