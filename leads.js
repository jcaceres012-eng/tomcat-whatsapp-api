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
ALTER TABLE leads ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS brand TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS product TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS order_id TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sale_source TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sale_ad_id TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS purchase_channel TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS quote_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS checkout_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS q_tipo TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS q_marca TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS q_modelo TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS q_cuando TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS q_ciudad TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bot_step TEXT;
CREATE TABLE IF NOT EXISTS sales (
  id             TEXT PRIMARY KEY,
  phone          TEXT NOT NULL,
  sale_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  value          NUMERIC(12,2) NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'HNL',
  brand          TEXT,
  product        TEXT,
  order_id       TEXT,
  source         TEXT,
  ad_id          TEXT,
  channel        TEXT,
  purchase_sent  BOOLEAN NOT NULL DEFAULT false,
  status         TEXT NOT NULL DEFAULT 'confirmada'
);
CREATE INDEX IF NOT EXISTS idx_sales_phone ON sales (phone);
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

// Campos opcionales del mensaje de venta: "Marca: Invicta", "Modelo: Pro Diver 8926", "Pedido: 1045"
const BRAND_RE = /^\s*\*?marca\*?\s*:\s*(.+)$/im;
const PRODUCT_RE = /^\s*\*?(?:modelo|producto|reloj)\*?\s*:\s*(.+)$/im;
const ORDER_RE = /pedido\s*(?:#|n[°ºo]\.?|:)\s*([A-Za-z0-9-]{1,30})/i;
// La tienda pide los datos de envío (inicio de compra)
const CHECKOUT_RE = /(para coordinar su env[ií]o|gestionar su orden|nombre completo[\s\S]{0,80}direcci[oó]n)/i;
// La tienda envía un precio en lempiras (cotización)
const QUOTE_RE = /(?:\bL\.?|\bLps\.?|\bHNL)\s?\d{1,2}[,.]?\d{3}/i;

function cleanField(v, max = 80) {
  if (!v) return null;
  const t = String(v).replace(/[*_~]/g, '').trim();
  return t ? t.slice(0, max) : null;
}

/** Devuelve { value, brand?, product?, orderId? } si el texto es un mensaje de venta confirmada, si no null. */
function parseSaleMessage(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!SALE_LINE.test(lines[i])) continue;
    // El total debe estar en la misma línea o en las 5 siguientes
    const m = TOTAL_RE.exec(lines.slice(i, i + 6).join('\n'));
    const value = m ? parseAmount(m[1]) : null;
    if (value) {
      const t = String(text);
      const b = BRAND_RE.exec(t), p = PRODUCT_RE.exec(t), o = ORDER_RE.exec(t);
      return { value, brand: cleanField(b && b[1]), product: cleanField(p && p[1], 120), orderId: cleanField(o && o[1], 30) };
    }
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

// Campos que setFields puede escribir (nombres fijos: nunca vienen del usuario)
const SETTABLE = ['status', 'brand', 'product', 'quote_at', 'checkout_at', 'qualified_at',
  'q_tipo', 'q_marca', 'q_modelo', 'q_cuando', 'q_ciudad', 'bot_step'];

function memoryStore() {
  const rows = new Map();
  const sales = new Map();
  return {
    async init() {},
    async upsertContact(phone, click, name) {
      const now = new Date();
      const r = rows.get(phone) || { phone, first_seen: now, status: 'consulta', purchase_sent: false };
      r.last_seen = now;
      if (name) r.name = name;
      if (click) Object.assign(r, { ctwa_clid: click.ctwaClid, ad_id: click.adId, ad_headline: click.headline || null,
        click_at: now, waba_id: click.wabaId });
      rows.set(phone, r);
    },
    async get(phone) { return rows.get(phone) || null; },
    async markSale(phone, { value, messageId, purchaseSent, brand, product, orderId, source, adId, channel }) {
      const now = new Date();
      const r = rows.get(phone) || { phone, first_seen: now, status: 'consulta' };
      Object.assign(r, { last_seen: now, status: 'vendido', sale_value: value, sale_at: now,
        sale_message_id: messageId, purchase_sent: Boolean(purchaseSent), brand: brand || r.brand,
        product: product || r.product, order_id: orderId || null, sale_source: source, sale_ad_id: adId || null,
        purchase_channel: channel || null });
      rows.set(phone, r);
      sales.set(messageId, { id: messageId, phone, sale_at: now, value, brand, product, order_id: orderId, source, ad_id: adId, channel, purchase_sent: Boolean(purchaseSent) });
    },
    async setFields(phone, fields) {
      const now = new Date();
      const r = rows.get(phone) || { phone, first_seen: now, status: 'consulta' };
      Object.assign(r, fields, { last_seen: now });
      rows.set(phone, r);
    },
    async listSales(limit = 200) { return [...sales.values()].slice(-limit).reverse(); },
    async hasSale(id) { return sales.has(id); },
    async list(limit = 200) { return [...rows.values()].slice(-limit).reverse(); },
    async counts() {
      const out = {}; for (const r of rows.values()) out[r.status] = (out[r.status] || 0) + 1; return out;
    }
  };
}

function pgStore(pool) {
  return {
    async init() { await pool.query(SCHEMA); },
    async upsertContact(phone, click, name) {
      // El nombre de perfil de WhatsApp se guarda/actualiza solo si viene en el mensaje
      if (click) {
        await pool.query(
          `INSERT INTO leads (phone, ctwa_clid, ad_id, ad_headline, click_at, waba_id, name)
           VALUES ($1,$2,$3,$4,now(),$5,$6)
           ON CONFLICT (phone) DO UPDATE SET last_seen=now(), ctwa_clid=$2, ad_id=$3,
             ad_headline=$4, click_at=now(), waba_id=$5, name=COALESCE($6, leads.name)`,
          [phone, click.ctwaClid, click.adId || null, click.headline || null, click.wabaId || null, name || null]);
      } else {
        await pool.query(
          `INSERT INTO leads (phone, name) VALUES ($1,$2)
           ON CONFLICT (phone) DO UPDATE SET last_seen=now(), name=COALESCE($2, leads.name)`, [phone, name || null]);
      }
    },
    async get(phone) {
      const r = await pool.query(`SELECT * FROM leads WHERE phone=$1`, [phone]);
      return r.rows[0] || null;
    },
    async markSale(phone, { value, messageId, purchaseSent, brand, product, orderId, source, adId, channel }) {
      await pool.query(
        `INSERT INTO leads (phone, status, sale_value, sale_at, sale_message_id, purchase_sent, brand, product,
           order_id, sale_source, sale_ad_id, purchase_channel)
         VALUES ($1,'vendido',$2,now(),$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (phone) DO UPDATE SET last_seen=now(), status='vendido', sale_value=$2,
           sale_at=now(), sale_message_id=$3, purchase_sent=$4, brand=COALESCE($5, leads.brand),
           product=COALESCE($6, leads.product), order_id=$7, sale_source=$8, sale_ad_id=$9, purchase_channel=$10`,
        [phone, value, messageId, Boolean(purchaseSent), brand || null, product || null, orderId || null,
          source || null, adId || null, channel || null]);
      await pool.query(
        `INSERT INTO sales (id, phone, value, brand, product, order_id, source, ad_id, channel, purchase_sent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [messageId, phone, value, brand || null, product || null, orderId || null, source || null, adId || null,
          channel || null, Boolean(purchaseSent)]);
    },
    async setFields(phone, fields) {
      const keys = Object.keys(fields).filter(k => SETTABLE.includes(k));
      if (!keys.length) return;
      const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
      const cols = keys.join(', ');
      const params = keys.map((_, i) => `$${i + 2}`).join(', ');
      await pool.query(
        `INSERT INTO leads (phone, ${cols}) VALUES ($1, ${params})
         ON CONFLICT (phone) DO UPDATE SET last_seen=now(), ${sets}`,
        [phone, ...keys.map(k => fields[k])]);
    },
    async listSales(limit = 200) {
      const r = await pool.query(`SELECT * FROM sales ORDER BY sale_at DESC LIMIT $1`, [limit]);
      return r.rows;
    },
    async hasSale(id) {
      const r = await pool.query(`SELECT 1 FROM sales WHERE id=$1`, [id]);
      return r.rowCount > 0;
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
    const name = profileName ? String(profileName).slice(0, 80) : null;
    await safe('upsertContact', () => store.upsertContact(phone, click, name));
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
  async function recordSale(phoneRaw, value, saleId, { wabaId, source = 'whatsapp', brand, product, orderId } = {}) {
    const phone = capi.normalizePhone(phoneRaw);
    const amount = Number(value);
    if (!phone || !Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'invalid_input' };
    // Una venta = un Purchase: el número de pedido (o el id del mensaje) es la clave de deduplicación
    const key = orderId ? `order_${orderId}` : String(saleId);
    if (seenSaleMessages.has(key)) return { ok: true, sale: true, duplicate: true };
    if (store.hasSale && await safe('hasSale', () => store.hasSale(key))) {
      seenSaleMessages.add(key);
      return { ok: true, sale: true, duplicate: true };
    }
    seenSaleMessages.add(key);
    if (seenSaleMessages.size > 5000) seenSaleMessages.clear();

    const row = await safe('get', () => store.get(phone));
    const brandF = brand || (row && (row.brand || row.q_marca)) || null;
    const productF = product || (row && (row.product || row.q_modelo)) || null;
    const customData = {
      content_type: 'product',
      content_name: [brandF, productF].filter(Boolean).join(' ') || undefined,
      content_category: brandF || undefined,
      order_id: orderId || undefined
    };
    const click = await findClick(phone);
    let result = { ok: false, reason: 'no_ctwa_clid' };
    let channel = null;
    if (click) {
      channel = 'business_messaging';
      result = await capi.sendEvent('Purchase', {
        phone, ctwaClid: click.ctwaClid, wabaId: click.wabaId || wabaId,
        value: amount, currency: 'HNL', eventId: `purchase_${key}`, customData
      });
    } else if (capi.sendChatEvent) {
      // Sin clic de anuncio: solo con autorización (CAPI_SEND_HASHED_PHONE=true), teléfono cifrado
      channel = 'chat';
      result = await capi.sendChatEvent('Purchase', {
        phone, value: amount, currency: 'HNL', eventId: `purchase_${key}`, customData
      });
      if (!result.ok && result.reason === 'hashed_phone_disabled') channel = null;
    }
    await safe('markSale', () => store.markSale(phone, {
      value: amount, messageId: key, purchaseSent: result.ok, brand: brandF, product: productF, orderId,
      source, adId: click ? click.adId : (row && row.ad_id) || null, channel: result.ok ? channel : null
    }));
    sheet.push({
      phone, status: 'vendido', saleValue: amount, saleAt: new Date().toISOString(),
      purchaseSent: Boolean(result.ok), adId: click ? click.adId : undefined, brand: brandF, product: productF
    }, { force: true }).catch(() => {});
    log('SALE_DETECTED', {
      phone: capi.maskPhone(phone), value: amount, currency: 'HNL', source, brand: brandF,
      fromAd: Boolean(click), purchaseSent: Boolean(result.ok), channel: result.ok ? channel : null,
      reason: result.ok ? undefined : result.reason
    });
    return { ok: true, sale: true, value: amount, fromAd: Boolean(click), purchaseSent: Boolean(result.ok),
      channel: result.ok ? channel : null, reason: result.ok ? undefined : result.reason };
  }

  /** Envía un evento de embudo (no compra) una sola vez por cliente y tipo. */
  async function funnelEvent(phone, eventName, eventId, customData) {
    const click = await findClick(phone);
    if (click) {
      return capi.sendEvent(eventName, { phone, ctwaClid: click.ctwaClid, wabaId: click.wabaId, eventId, customData });
    }
    // Sin clic: QualifiedLead puede ir por "chat" solo con autorización; los demás no se envían
    if (eventName === 'QualifiedLead' && capi.sendChatEvent) {
      return capi.sendChatEvent('Lead', { phone, eventId, customData: { ...(customData || {}), lead_event_source: 'whatsapp_calificado' } });
    }
    return { ok: false, reason: 'no_ctwa_clid' };
  }

  /**
   * Calificación comercial (bot o asesor). Si el cliente quiere comprar esta semana
   * o este mes, el lead queda "calificado" y se envía QualifiedLead una sola vez.
   */
  async function qualify(phoneRaw, fields, { source = 'bot' } = {}) {
    const phone = capi.normalizePhone(phoneRaw);
    if (!phone) return { ok: false, reason: 'invalid_phone' };
    const clean = {};
    for (const k of ['q_tipo', 'q_marca', 'q_modelo', 'q_ciudad']) {
      if (fields[k]) clean[k] = cleanField(fields[k], 80);
    }
    if (['esta_semana', 'este_mes', 'viendo'].includes(fields.q_cuando)) clean.q_cuando = fields.q_cuando;
    const row = await safe('get', () => store.get(phone));
    const soon = ['esta_semana', 'este_mes'].includes(clean.q_cuando || (row && row.q_cuando));
    let sent = null;
    if (soon && !(row && row.qualified_at)) {
      clean.qualified_at = new Date();
      if (!row || ['consulta', 'cotizado'].includes(row.status)) clean.status = 'calificado';
      const marca = clean.q_marca || (row && row.q_marca);
      sent = await funnelEvent(phone, 'QualifiedLead', `qualified_${phone}`, marca ? { content_category: marca, content_name: marca } : undefined);
    }
    await safe('setFields', () => store.setFields(phone, clean));
    log('LEAD_QUALIFIED', { phone: capi.maskPhone(phone), source, marca: clean.q_marca, cuando: clean.q_cuando,
      ciudad: clean.q_ciudad, calificado: Boolean(clean.qualified_at), eventSent: sent ? Boolean(sent.ok) : false });
    return { ok: true, qualified: Boolean(clean.qualified_at), eventSent: sent ? Boolean(sent.ok) : false };
  }

  /**
   * Mensaje enviado por el negocio desde la app (smb_message_echoes).
   * - "✅ Pedido confirmado … Total: L X" → venta (Purchase con valor).
   * - Pide nombre, teléfono y dirección para el envío → InitiateCheckout (una vez).
   * - Envía un precio en lempiras → cotización (solo se registra; no es venta).
   */
  async function onBusinessEcho(echo, wabaId) {
    const text = messageText(echo);
    const sale = parseSaleMessage(text);
    if (sale) {
      return recordSale(echo.to, sale.value, echo.id, { wabaId, source: 'whatsapp', brand: sale.brand, product: sale.product, orderId: sale.orderId });
    }
    const phone = capi.normalizePhone(echo.to);
    if (!phone || !text) return { sale: false };
    const row = await safe('get', () => store.get(phone));
    if (CHECKOUT_RE.test(text)) {
      if (!(row && row.checkout_at)) {
        await safe('setFields', () => store.setFields(phone, { checkout_at: new Date() }));
        const r = await funnelEvent(phone, 'InitiateCheckout', `checkout_${phone}_${new Date().toISOString().slice(0, 10)}`);
        log('CHECKOUT_DETECTED', { phone: capi.maskPhone(phone), eventSent: Boolean(r && r.ok) });
      }
      return { sale: false, checkout: true };
    }
    if (QUOTE_RE.test(text)) {
      const f = { quote_at: new Date() };
      if (!row || row.status === 'consulta') f.status = 'cotizado';
      await safe('setFields', () => store.setFields(phone, f));
      return { sale: false, quote: true };
    }
    return { sale: false };
  }

  return {
    init: () => store.init(),
    onIncoming, onBusinessEcho, recordSale, findClick, qualify,
    get: (phone) => safe('get', () => store.get(capi.normalizePhone(phone))),
    setFields: (phone, f) => safe('setFields', () => store.setFields(capi.normalizePhone(phone), f)),
    listSales: (n) => safe('listSales', () => store.listSales(n)),
    list: (n) => store.list(n),
    counts: () => safe('counts', () => store.counts()),
    backend: pool ? 'postgres' : 'memory'
  };
}

module.exports = { createLeads, parseSaleMessage, parseAmount, messageText, CHECKOUT_RE, QUOTE_RE };
