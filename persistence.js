/**
 * persistence.js — Persistencia diferenciada por criticidad.
 *
 * POLITICA (justificada en el informe):
 *   tokens         -> WRITE-AHEAD. Base confirma ANTES de tocar memoria.
 *                     3 reintentos con backoff. Si falla, LANZA: el llamador
 *                     debe devolver error, nunca informar exito.
 *   sessions       -> best-effort. Reintentar el flujo es barato (TTL 15 min).
 *   phoneNumbers   -> best-effort. Reconstruible desde la API de Meta.
 *   webhookEvents  -> NUNCA se persisten. Diagnostico, con tope de 1000.
 *
 * Degradacion: si la base cae EN MARCHA, el servicio sigue recibiendo
 * webhooks (los mensajes no se persisten de todos modos), pero readiness
 * pasa a 503 y toda escritura critica falla de forma ruidosa.
 */

const { Pool } = require('pg');
const { createStore } = require('./store-postgres');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function esConexionLocal(url) {
  return /localhost|127\.0\.0\.1|host=\/|^\/|\.internal\b/.test(url || '');
}

function createPersistence({ databaseUrl, encryptionKey, logger }) {
  const log = logger || (() => {});

  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL no esta configurada. El servicio no arranca: sin base de datos, ' +
      'el token de Coexistence se perderia en el primer reinicio y no puede volver ' +
      'a obtenerse sin offboarding.'
    );
  }

  // Render Postgres exige SSL en conexiones externas. En interno/local, no.
  const usaSSL = !esConexionLocal(databaseUrl);
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: usaSSL ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000
  });

  pool.on('error', e => { estado.dbHealthy = false; log('PERSISTENCE_POOL_ERROR', { mensaje: e.message.slice(0,120) }); });

  const store = createStore({ pool, encryptionKey });

  // Estado observable por readiness
  const estado = { dbHealthy: false, hydrated: false, hydratedAt: null, ssl: usaSSL, keyMismatch: false };

  async function init() {
    await store.init();
    estado.dbHealthy = true;
    return { keyFingerprint: store.keyFingerprint, ssl: usaSSL };
  }

  /**
   * Hidratacion. LANZA si falla: el arranque debe abortar, no servir con
   * el almacen incompleto.
   */
  async function hydrate(coexistenceStore, targetPhoneNumber) {
    const resumen = { phoneNumbers: 0, tokens: 0, tokenKeyMismatch: false };

    const phone = await store.getPhoneNumber(targetPhoneNumber);
    if (phone) { coexistenceStore.phoneNumbers[targetPhoneNumber] = phone; resumen.phoneNumbers = 1; }

    const tok = await store.getToken(targetPhoneNumber);
    if (tok) {
      if (tok.keyMismatch) {
        resumen.tokenKeyMismatch = true;
        estado.keyMismatch = true;
        log('PERSISTENCE_KEY_MISMATCH', {
          aviso: 'La ENCRYPTION_KEY cambio: el token almacenado no es descifrable. ' +
                 'Requiere reautenticacion via Embedded Signup.'
        });
      } else if (tok.token) {
        coexistenceStore.tokens[targetPhoneNumber] = {
          encryptedToken: '[en base de datos]', expiresAt: tok.expiresAt || null, type: tok.type
        };
        resumen.tokens = 1;
      }
    }

    // Reconciliacion: numero vinculado sin token es un estado incoherente.
    if (resumen.phoneNumbers === 1 && resumen.tokens === 0 && !resumen.tokenKeyMismatch) {
      log('PERSISTENCE_RECONCILIACION', {
        severidad: 'critica',
        aviso: 'Hay un numero vinculado pero NO hay token en base. ' +
               'Requiere reautenticacion via Embedded Signup.'
      });
    }

    estado.dbHealthy = true;
    estado.hydrated = true;
    estado.hydratedAt = new Date().toISOString();
    return resumen;
  }

  // ---------- CRITICO: write-ahead con reintentos ----------
  /**
   * Persiste el token en base ANTES de que el llamador toque memoria.
   * LANZA si no lo consigue. No devuelve false silenciosamente.
   */
  async function persistTokenCritical(phone, plaintextToken, expiresAt, type) {
    // Guarda contra sobrescribir un token valido con datos incompletos
    if (typeof plaintextToken !== 'string' || plaintextToken.trim().length < 10) {
      throw new Error('Token vacio o demasiado corto: se rechaza la escritura para ' +
                      'no sobrescribir un token valido con datos incompletos.');
    }
    if (!phone) throw new Error('Telefono requerido para persistir el token.');

    let ultimoError;
    for (let intento = 1; intento <= 3; intento++) {
      try {
        await store.saveToken(phone, plaintextToken, expiresAt, type);
        estado.dbHealthy = true;
        log('TOKEN_PERSISTIDO', { intentos: intento, tipo: type || 'desconocido' });
        return { ok: true, intentos: intento };
      } catch (e) {
        ultimoError = e;
        estado.dbHealthy = false;
        log('TOKEN_PERSIST_REINTENTO', { intento, mensaje: e.message.slice(0, 120) });
        if (intento < 3) await sleep(250 * intento);   // 250ms, 500ms
      }
    }
    throw new Error('No se pudo persistir el token de Coexistence tras 3 intentos: ' +
                    (ultimoError ? ultimoError.message.slice(0,140) : 'error desconocido'));
  }

  // ---------- BEST-EFFORT: no lanzan, registran ----------
  const bestEffort = (nombre, fn) => async (...args) => {
    try { await fn(...args); estado.dbHealthy = true; return true; }
    catch (e) { estado.dbHealthy = false;
      log('PERSISTENCE_WRITE_ERROR', { op: nombre, mensaje: e.message.slice(0,120) }); return false; }
  };
  const persistPhoneNumber = bestEffort('phoneNumber', (p,o) => store.savePhoneNumber(p,o));
  const persistSession     = bestEffort('session', (s,d,e) => store.saveSession(s,d,e));
  const removeSession      = bestEffort('deleteSession', s => store.deleteSession(s));

  async function getTokenPlaintext(phone) {
    try { const r = await store.getToken(phone); estado.dbHealthy = true; return r; }
    catch (e) { estado.dbHealthy = false;
      log('PERSISTENCE_READ_ERROR', { mensaje: e.message.slice(0,120) }); return null; }
  }

  /** Readiness: comprueba base + hidratacion. Sin datos sensibles. */
  async function readiness() {
    const checks = { database: false, hydrated: estado.hydrated, encryptionKey: true, keyMismatch: estado.keyMismatch };
    try { await pool.query('SELECT 1'); checks.database = true; estado.dbHealthy = true; }
    catch (_) { checks.database = false; estado.dbHealthy = false; }
    const ready = checks.database && checks.hydrated && !checks.keyMismatch;
    return { ready, checks };
  }

  async function counts() {
    try { return await store.counts(); }
    catch (_) { return null; }
  }

  return { init, hydrate, persistTokenCritical, persistPhoneNumber, persistSession,
           removeSession, getTokenPlaintext, readiness, counts,
           close: () => pool.end(), estado, keyFingerprint: store.keyFingerprint };
}

module.exports = { createPersistence };
