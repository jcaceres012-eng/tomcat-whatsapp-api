/**
 * Meta Conversions API para mensajería empresarial (WhatsApp)
 *
 * Basado en la documentación oficial:
 * https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging
 *
 * - action_source: "business_messaging"
 * - messaging_channel: "whatsapp"
 * - user_data: whatsapp_business_account_id + ctwa_clid (del objeto referral del webhook)
 * - Eventos admitidos: LeadSubmitted, Purchase, QualifiedLead, OrderCreated, etc.
 *
 * Solo se pueden atribuir conversaciones que iniciaron desde un anuncio
 * "clic a WhatsApp" (traen ctwa_clid). Las demás no se envían.
 */

const crypto = require('crypto');
const axios = require('axios');

const SUPPORTED_EVENTS = new Set([
  'Purchase', 'LeadSubmitted', 'InitiateCheckout', 'AddToCart', 'ViewContent',
  'OrderCreated', 'OrderShipped', 'OrderDelivered', 'OrderCanceled', 'OrderReturned',
  'CartAbandoned', 'QualifiedLead', 'RatingProvided', 'ReviewProvided'
]);

// Ventana de atribución para guardar el ctwa_clid de cada cliente
const CLICK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizePhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  // Números hondureños de 8 dígitos sin código de país
  if (digits.length === 8) digits = `504${digits}`;
  return digits || null;
}

function maskPhone(phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  return `${p.slice(0, 3)}****${p.slice(-2)}`;
}

function createCapi({ datasetId, accessToken, graphVersion = 'v25.0', testEventCode, defaultWabaId, logger }) {
  const log = logger || (() => {});
  const clicks = new Map(); // phone normalizado -> { ctwaClid, wabaId, adId, ts }

  const enabled = Boolean(datasetId && accessToken);

  function purgeOld() {
    const now = Date.now();
    for (const [k, v] of clicks) {
      if (now - v.ts > CLICK_TTL_MS) clicks.delete(k);
    }
  }

  /**
   * Registra el clic de un anuncio a partir de un mensaje entrante del webhook.
   * Devuelve el registro guardado o null si el mensaje no vino de un anuncio.
   */
  function rememberClick(message, wabaId) {
    const referral = message && message.referral;
    const ctwaClid = referral && referral.ctwa_clid;
    if (!ctwaClid) return null;
    const phone = normalizePhone(message.from);
    if (!phone) return null;
    purgeOld();
    const record = {
      ctwaClid,
      wabaId: wabaId || defaultWabaId,
      adId: referral.source_id || null,
      ts: Date.now()
    };
    clicks.set(phone, record);
    return record;
  }

  function getClick(phone) {
    purgeOld();
    return clicks.get(normalizePhone(phone)) || null;
  }

  /**
   * Envía un evento a la API de Conversiones.
   * Nunca lanza excepción: devuelve { ok, ... } y registra el resultado.
   */
  async function sendEvent(eventName, { phone, ctwaClid, wabaId, value, currency = 'HNL', eventId } = {}) {
    if (!enabled) {
      log('CAPI_SKIPPED', { reason: 'not_configured', eventName });
      return { ok: false, reason: 'not_configured' };
    }
    if (!SUPPORTED_EVENTS.has(eventName)) {
      log('CAPI_SKIPPED', { reason: 'unsupported_event', eventName });
      return { ok: false, reason: 'unsupported_event' };
    }

    const click = ctwaClid ? { ctwaClid, wabaId } : getClick(phone);
    if (!click || !click.ctwaClid) {
      log('CAPI_SKIPPED', { reason: 'no_ctwa_clid', eventName, phone: maskPhone(phone) });
      return { ok: false, reason: 'no_ctwa_clid' };
    }

    const resolvedWaba = click.wabaId || wabaId || defaultWabaId;
    if (!resolvedWaba) {
      log('CAPI_SKIPPED', { reason: 'no_waba_id', eventName });
      return { ok: false, reason: 'no_waba_id' };
    }

    const event = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId || crypto.randomUUID(),
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: {
        whatsapp_business_account_id: String(resolvedWaba),
        ctwa_clid: click.ctwaClid
      }
    };

    if (value !== undefined && value !== null && value !== '') {
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) {
        return { ok: false, reason: 'invalid_value' };
      }
      event.custom_data = { currency, value: num };
    }

    const body = { data: [event] };
    if (testEventCode) body.test_event_code = testEventCode;

    try {
      const response = await axios.post(
        `https://graph.facebook.com/${graphVersion}/${datasetId}/events`,
        body,
        {
          params: { access_token: accessToken },
          timeout: 10000
        }
      );
      log('CAPI_EVENT_SENT', {
        eventName,
        eventId: event.event_id,
        phone: maskPhone(phone),
        value: event.custom_data ? event.custom_data.value : undefined,
        eventsReceived: response.data && response.data.events_received,
        fbtraceId: response.data && response.data.fbtrace_id
      });
      return { ok: true, eventId: event.event_id, eventsReceived: response.data && response.data.events_received };
    } catch (error) {
      const metaError = error.response && error.response.data && error.response.data.error;
      log('CAPI_EVENT_ERROR', {
        eventName,
        phone: maskPhone(phone),
        status: error.response ? error.response.status : null,
        message: metaError ? metaError.message : error.message,
        code: metaError ? metaError.code : null,
        subcode: metaError ? metaError.error_subcode : null,
        fbtraceId: metaError ? metaError.fbtrace_id : null
      });
      return { ok: false, reason: 'meta_error', message: metaError ? metaError.message : error.message };
    }
  }

  function status() {
    return {
      enabled,
      datasetConfigured: Boolean(datasetId),
      tokenConfigured: Boolean(accessToken),
      graphVersion,
      testMode: Boolean(testEventCode),
      trackedClicks: clicks.size
    };
  }

  return { enabled, rememberClick, getClick, sendEvent, status, normalizePhone, maskPhone };
}

module.exports = { createCapi, normalizePhone, maskPhone, SUPPORTED_EVENTS };
