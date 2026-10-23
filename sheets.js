/**
 * sheets.js — Envía clientes y ventas a la hoja de Google (Apps Script web app).
 *
 * Variables de entorno: SHEETS_WEBHOOK_URL y SHEETS_SECRET.
 * Si faltan, no hace nada. Nunca bloquea el webhook ni lanza excepciones.
 * Para no saturar la hoja, "último mensaje" se actualiza como máximo cada 30 min por cliente.
 */
const axios = require('axios');

const TOUCH_INTERVAL_MS = 30 * 60 * 1000;

function createSheets({ url, secret, logger }) {
  const log = logger || (() => {});
  const enabled = Boolean(url && secret);
  const lastTouch = new Map();
  let lastResult = null;

  async function push(lead, { force = false } = {}) {
    if (!enabled || !lead || !lead.phone) return { ok: false, reason: 'not_configured' };
    const now = Date.now();
    if (!force) {
      const prev = lastTouch.get(lead.phone);
      if (prev && now - prev < TOUCH_INTERVAL_MS) return { ok: true, skipped: true };
    }
    lastTouch.set(lead.phone, now);
    if (lastTouch.size > 20000) lastTouch.clear();
    try {
      const r = await axios.post(url, { secret, lead }, { timeout: 15000, maxRedirects: 5,
        headers: { 'Content-Type': 'application/json' } });
      const ok = Boolean(r.data && r.data.ok);
      lastResult = { ok, at: new Date().toISOString(), error: ok ? undefined : (r.data && r.data.error) || 'respuesta_invalida' };
      if (!ok) log('SHEETS_ERROR', { error: lastResult.error });
      return { ok };
    } catch (e) {
      lastTouch.delete(lead.phone);
      lastResult = { ok: false, at: new Date().toISOString(), error: e.response ? `http_${e.response.status}` : 'red' };
      log('SHEETS_ERROR', { error: lastResult.error });
      return { ok: false };
    }
  }

  return { enabled, push, status: () => ({ enabled, last: lastResult }) };
}

module.exports = { createSheets };
