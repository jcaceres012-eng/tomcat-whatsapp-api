/**
 * leads.js — Registro de clientes potenciales y ventas detectadas por WhatsApp.
 *
 * - Guarda por cliente el clic del anuncio (ctwa_clid, ad_id) para poder atribuir
 *   la venta aunque el servidor se reinicie (antes solo vivía en memoria).
 * - Detecta ventas en los mensajes que el negocio envía desde la app de WhatsApp
 *   Business (webhook smb_message_echoes, modo coexistencia) cuando el mensaje
 *   empieza con "✅ Pedido confirmado" e incluye "Total: L 3,700".
 *
 * Sin DATABASE_URL usa memoria (pruebas / arranque degradado).
 * Los teléfonos completos solo se guardan en la base; nunca en logs públicos.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  phone          TEXT PRIMARY KEY,
  first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ctwa_clid      TEXT,
  ad_id          TEXT,
  ad_headline    TEXT,
  click_at       TIMESTAMPTZ,
  waba_id        TEXT,
  status         TEXT        NOT NULL DEFAULT 'consulta',
  sale_value     NUMERIC(12,2),
  sale_at        TIMESTAMPTZ,
  sale_message_id TEXT,
  purchase_sent  BOOLEAN     NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_last_seen ON leads (last_seen);
`;

// Ventana de atribución de Meta para clic a WhatsApp
const ATTRIBUTION_MS = 7 * 24 * 60 * 60 * 1000;

// Una línea que empieza con "✅ Pedido confirmado" (con o sin emoji), en cualquier parte del mensaje.
const SALE_LINE = /^\s*(?:✅|✔️|✔|☑️)?\s*\*?pedido\s+confirmado\b/i;
// "Total: L 3,700" · "Total L. 3700.00" · "TOTAL: Lps 3.700" · "total: L3,700"
const TOTAL_RE = /total\s*:?\s*(?:L|Lps|HNL)\.?\s*([0-9][0-9.,]*)/i;

/** Convierte "3,700" / "3.700" / "3,700.50" / "3700" a número. */
function parseAmount(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[.,]$/, '');
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');          // 3.700 -> miles
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, ''); // 3,700.50
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');             // 3700,50
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** Devuelve { value } si el texto es un mensaje de venta confirmada, si no null. */
function parseSaleMessage(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!SALE_LINE.test(lines[i])) continue;
    // El total debe estar en la misma línea o en las 3 siguientes
    const m = TOTAL_RE.exec(lines.slice(i, i + 4).join('\n'));
    const value = m ? parseAmount(m[1]) : null;
    if (value) return { value };
  }
  return null;
}

/** Texto de un mensaje del negocio: cuerpo de texto o descripción de foto/video/documento. */
function messageText(msg) {
  if (!msg) return null;
  if (msg.type === 'text') return msg.text && msg.text.body;
  const media = msg[msg.type];
  return media && typeof media.caption === 'string' ? media.caption : null;
}

function memoryStore() {
  const rows = new Map();
  return {
    async init() {},
    async upsertContact(phone, click) {
      const now = new Date();
      const r = rows.get(phone) || { phone, first_seen: now, status: 'consulta', purchase_sent: false };
      r.last_seen = now;
      if (click) Object.assign(r, { ctwa_clid: click.ctwaClid, ad_id: click.adId, ad_headline: click.headline || null,
        click_at: now, waba_id: click.wabaId });
      rows.set(phone, r);
    },
    async get(phone) { return rows.get(phone) || null; },
    async markSale(phone, { value, messageId, purchaseSent }) {
      const now = new Date();
      const r = rows.get(phone) || { phone, first_seen: now, status: 'consulta' };
      Object.assign(r, { last_seen: now, status: 'vendido', sale_value: value, sale_at: now,
        sale_message_id: messageId, purchase_sent: Boolean(purchaseSent) });
      rows.set(phone, r);
    },
    async list(limit = 200) { return [...rows.values()].slice(-limit).reverse(); },
    async counts() {
      const out = {}; for (const r of rows.values()) out[r.status] = (out[r.status] || 0) + 1; return out;
    }
  };
}

function pgStore(pool) {
  return {
    async init() { await pool.query(SCHEMA); },
    async upsertContact(phone, click) {
      if (click) {
        await pool.query(
          `INSERT INTO leads (phone, ctwa_clid, ad_id, ad_headline, click_at, waba_id)
           VALUES ($1,$2,$3,$4,now(),$5)
           ON CONFLICT (phone) DO UPDATE SET last_seen=now(), ctwa_clid=$2, ad_id=$3,
             ad_headline=$4, click_at=now(), waba_id=$5`,
          [phone, click.ctwaClid, click.adId || null, click.headline || null, click.wabaId || null]);
      } else {
        await pool.query(
          `INSERT INTO leads (phone) VALUES ($1)
           ON CONFLICT (phone) DO UPDATE SET last_seen=now()`, [phone]);
      }
    },
    async get(phone) {
      const r = await pool.query(`SELECT * FROM leads WHERE phone=$1`, [phone]);
      return r.rows[0] || null;
    },
    async markSale(phone, { value, messageId, purchaseSent }) {
      await pool.query(
        `INSERT INTO leads (phone, status, sale_value, sale_at, sale_message_id, purchase_sent)
         VALUES ($1,'vendido',$2,now(),$3,$4)
         ON CONFLICT (phone) DO UPDATE SET last_seen=now(), status='vendido', sale_value=$2,
           sale_at=now(), sale_message_id=$3, purchase_sent=$4`,
        [phone, value, messageId, Boolean(purchaseSent)]);
    },
    async list(limit = 200) {
      const r = await pool.query(`SELECT * FROM leads ORDER BY last_seen DESC LIMIT $1`, [limit]);
      return r.rows;
    },
    async counts() {
      const r = await pool.query(`SELECT status, count(*)::int AS n FROM leads GROUP BY status`);
      return Object.fromEntries(r.rows.map(x => [x.status, x.n]));
    }
  };
}

function createLeads({ pool, capi, logger, sheets }) {
  const log = logger || (() => {});
  const sheet = sheets || { push: async () => ({ ok: false }) };
  const store = pool ? pgStore(pool) : memoryStore();
  const seenSaleMessages = new Set();

  async function safe(op, fn) {
    try { return await fn(); }
    catch (e) { log('LEADS_DB_ERROR', { op, mensaje: String(e.message).slice(0, 120) }); return null; }
  }

  /** Mensaje entrante de un cliente. Guarda el clic del anuncio si lo trae. */
  async function onIncoming(message, wabaId, profileName) {
    const phone = capi.normalizePhone(message.from);
    if (!phone) return null;
    const click = capi.rememberClick(message, wabaId);
    if (click && message.referral && message.referral.headline) click.headline = String(message.referral.headline).slice(0, 200);
    await safe('upsertContact', () => store.upsertContact(phone, click));
    sheet.push({
      phone,
      name: profileName ? String(profileName).slice(0, 80) : undefined,
      adId: click ? click.adId : undefined,
      adHeadline: click ? click.headline : undefined,
      status: 'consulta',
      lastMessageAt: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : undefined
    }, { force: Boolean(click) }).catch(() => {});
    return click;
  }

  /** Busca el clic vigente (memoria primero, luego base). */
  async function findClick(phone) {
    const mem = capi.getClick(phone);
    if (mem) return mem;
    const row = await safe('get', () => store.get(phone));
    if (!row || !row.ctwa_clid || !row.click_at) return null;
    if (Date.now() - new Date(row.click_at).getTime() > ATTRIBUTION_MS) return null;
    return { ctwaClid: row.ctwa_clid, wabaId: row.waba_id, adId: row.ad_id };
  }

  /**
   * Mensaje enviado por el negocio desde la app (smb_message_echoes).
   * Si es una confirmación de venta, registra la venta y envía Purchase.
   */
  /** Registra una venta y, si el cliente vino de un anuncio, envía Purchase a Meta. */
  async function recordSale(phoneRaw, value, saleId, { wabaId, source = 'whatsapp' } = {}) {
    const phone = capi.normalizePhone(phoneRaw);
    const amount = Number(value);
    if (!phone || !Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'invalid_input' };
    if (seenSaleMessages.has(saleId)) return { ok: true, sale: true, duplicate: true };
    seenSaleMessages.add(saleId);
    if (seenSaleMessages.size > 5000) seenSaleMessages.clear();

    const click = await findClick(phone);
    let result = { ok: false, reason: 'no_ctwa_clid' };
    if (click) {
      result = await capi.sendEvent('Purchase', {
        phone, ctwaClid: click.ctwaClid, wabaId: click.wabaId || wabaId,
        value: amount, currency: 'HNL', eventId: `purchase_${saleId}`
      });
    }
    await safe('markSale', () => store.markSale(phone, { value: amount, messageId: saleId, purchaseSent: result.ok }));
    sheet.push({
      phone, status: 'vendido', saleValue: amount, saleAt: new Date().toISOString(),
      purchaseSent: Boolean(result.ok), adId: click ? click.adId : undefined
    }, { force: true }).catch(() => {});
    log('SALE_DETECTED', {
      phone: capi.maskPhone(phone), value: amount, currency: 'HNL', source,
      fromAd: Boolean(click), purchaseSent: Boolean(result.ok), reason: result.ok ? undefined : result.reason
    });
    return { ok: true, sale: true, value: amount, fromAd: Boolean(click), purchaseSent: Boolean(result.ok),
      reason: result.ok ? undefined : result.reason };
  }

  /**
   * Mensaje enviado por el negocio desde la app (smb_message_echoes).
   * Si contiene "✅ Pedido confirmado … Total: L X" (texto o descripción de foto), registra la venta.
   */
  async function onBusinessEcho(echo, wabaId) {
    const sale = parseSaleMessage(messageText(echo));
    if (!sale) return { sale: false };
    return recordSale(echo.to, sale.value, echo.id, { wabaId, source: 'whatsapp' });
  }

  return {
    init: () => store.init(),
    onIncoming, onBusinessEcho, recordSale, findClick,
    list: (n) => store.list(n),
    counts: () => safe('counts', () => store.counts()),
    backend: pool ? 'postgres' : 'memory'
  };
}

module.exports = { createLeads, parseSaleMessage, parseAmount, messageText };
