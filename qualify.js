/**
 * qualify.js — Calificación comercial ligera para chats que llegan desde un anuncio.
 *
 * Tres toques y una pregunta abierta, con botones de WhatsApp para que no sea un interrogatorio:
 *   1. ¿Para quién es el reloj?      (botones)
 *   2. ¿Qué marca te gusta?          (lista; invita a mandar foto del modelo)
 *   3. ¿Para cuándo lo necesitas?    (botones)
 *   4. ¿A qué ciudad te lo enviamos? (texto libre)
 * "Esta semana" o "Este mes" marca el lead como calificado y envía QualifiedLead a Meta.
 *
 * Modos (QUALIFY_BOT_MODE): off (por defecto) · test · ads.
 *   test → solo arranca cuando alguien escribe la palabra clave de prueba (QUALIFY_TEST_KEYWORD,
 *          por defecto "#probarbot"); nunca toca chats de anuncios. Sirve para probar sin
 *          chocar con Meta Business Agent ni con clientes reales.
 *   ads  → arranca en chats que traen el clic del anuncio (referral). QUALIFY_BOT_ENABLED=true
 *          equivale a ads (compatibilidad). La palabra clave de prueba sigue funcionando.
 * Nunca responde a clientes que ya compraron. Son respuestas dentro de la ventana de 24 h que abre el propio cliente: no son
 * mensajes masivos ni plantillas de marketing.
 */
const axios = require('axios');

const STEPS = { tipo: 'tipo', marca: 'marca', cuando: 'cuando', ciudad: 'ciudad', fin: 'fin' };

const TEXTS = {
  tipo: '¡Hola! 👋 Gracias por escribir a Tomcat Store ⌚\nEn un momento un asesor te comparte fotos y precios. Para ayudarte más rápido: ¿el reloj es para…?',
  marca: '¿Qué marca te gusta? Si ya tienes un modelo en mente, envíanos la foto cuando quieras 📸',
  cuando: '¿Para cuándo lo necesitas?',
  ciudad: '¡Perfecto! ¿A qué ciudad te lo enviamos? El envío es gratis a toda Honduras 🚚',
  fin: '¡Gracias! Un asesor te escribe ya con las opciones. Pagas en efectivo cuando recibes tu reloj ✅'
};

const TIPO = [
  { id: 'q_tipo:hombre', title: 'Hombre' },
  { id: 'q_tipo:mujer', title: 'Mujer' },
  { id: 'q_tipo:regalo', title: 'Es un regalo' }
];
const MARCAS = [
  { id: 'q_marca:Invicta', title: 'Invicta' },
  { id: 'q_marca:Fossil', title: 'Fossil' },
  { id: 'q_marca:Casio', title: 'Casio / G-Shock' },
  { id: 'q_marca:Pagani Design', title: 'Pagani Design' },
  { id: 'q_marca:Diesel', title: 'Diesel' },
  { id: 'q_marca:Bulova', title: 'Bulova' },
  { id: 'q_marca:Otra', title: 'Otra marca' },
  { id: 'q_marca:No sé', title: 'Aún no sé' }
];
const CUANDO = [
  { id: 'q_cuando:esta_semana', title: 'Esta semana' },
  { id: 'q_cuando:este_mes', title: 'Este mes' },
  { id: 'q_cuando:viendo', title: 'Solo estoy viendo' }
];

function replyId(message) {
  const i = message && message.interactive;
  if (!i) return null;
  if (i.button_reply) return i.button_reply.id;
  if (i.list_reply) return i.list_reply.id;
  return null;
}

function resolveMode(mode, enabled) {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'test' || m === 'ads' || m === 'off') return m;
  return enabled ? 'ads' : 'off';
}

function createQualifier({ getLeads, capi, accessToken, phoneNumberId, graphVersion = 'v25.0', enabled = false, mode, testKeyword, logger }) {
  const log = logger || (() => {});
  const botMode = resolveMode(mode, enabled);
  const on = Boolean(botMode !== 'off' && accessToken && phoneNumberId);
  const keyword = String(testKeyword || '#probarbot').trim().toLowerCase();
  const isKeyword = (m) => Boolean(m && m.type === 'text' && m.text && m.text.body &&
    m.text.body.trim().toLowerCase() === keyword);

  async function send(to, payload) {
    try {
      await axios.post(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`,
        { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload },
        { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 });
      return true;
    } catch (e) {
      const err = e.response && e.response.data && e.response.data.error;
      log('QUALIFY_SEND_ERROR', { to: capi.maskPhone(to), code: err ? err.code : null, message: err ? String(err.message).slice(0, 120) : e.message });
      return false;
    }
  }

  const buttons = (to, text, opts) => send(to, { type: 'interactive', interactive: {
    type: 'button', body: { text }, action: { buttons: opts.map(o => ({ type: 'reply', reply: { id: o.id, title: o.title } })) } } });
  const list = (to, text, opts) => send(to, { type: 'interactive', interactive: {
    type: 'list', body: { text }, action: { button: 'Ver marcas', sections: [{ title: 'Marcas', rows: opts.map(o => ({ id: o.id, title: o.title })) }] } } });
  const text = (to, body) => send(to, { type: 'text', text: { body } });

  /**
   * Procesa un mensaje entrante. Devuelve true si el bot respondió.
   * `click` es el clic del anuncio que leads.onIncoming acaba de guardar (o null).
   */
  async function onIncoming(message, click) {
    if (!on || !message || message.from_me) return false;
    const leads = getLeads();
    const to = message.from;
    // Palabra clave de prueba: funciona para cualquier número, aunque ya sea cliente
    if (isKeyword(message)) {
      log('QUALIFY_TEST_START', { to: capi.maskPhone(to), mode: botMode });
      await leads.setFields(to, { bot_step: STEPS.tipo });
      return buttons(to, TEXTS.tipo, TIPO);
    }

    const row = await leads.get(to);
    const step = row && row.bot_step;
    // Una prueba en curso (iniciada con la palabra clave) sigue aunque el número sea de un cliente
    if (row && row.status === 'vendido' && !step) return false;

    const id = replyId(message);
    if (id && id.startsWith('q_')) {
      const [field, value] = id.split(':');
      if (field === 'q_tipo') {
        await leads.qualify(to, { q_tipo: value }, { source: 'bot' });
        await leads.setFields(to, { bot_step: STEPS.marca });
        return list(to, TEXTS.marca, MARCAS);
      }
      if (field === 'q_marca') {
        await leads.qualify(to, { q_marca: value }, { source: 'bot' });
        await leads.setFields(to, { bot_step: STEPS.cuando, brand: value === 'No sé' || value === 'Otra' ? null : value });
        return buttons(to, TEXTS.cuando, CUANDO);
      }
      if (field === 'q_cuando') {
        await leads.qualify(to, { q_cuando: value }, { source: 'bot' });
        await leads.setFields(to, { bot_step: STEPS.ciudad });
        return text(to, TEXTS.ciudad);
      }
      return false;
    }

    if (step === STEPS.ciudad && message.type === 'text' && message.text && message.text.body) {
      await leads.qualify(to, { q_ciudad: message.text.body.slice(0, 60) }, { source: 'bot' });
      await leads.setFields(to, { bot_step: STEPS.fin });
      return text(to, TEXTS.fin);
    }

    // Primer mensaje de un chat que viene de un anuncio: arranca la calificación (solo modo ads)
    if (botMode === 'ads' && !step && click) {
      await leads.setFields(to, { bot_step: STEPS.tipo });
      return buttons(to, TEXTS.tipo, TIPO);
    }
    return false;
  }

  return { onIncoming, status: () => ({ enabled: on, mode: on ? botMode : 'off' }) };
}

module.exports = { createQualifier, resolveMode, TEXTS, TIPO, MARCAS, CUANDO };
