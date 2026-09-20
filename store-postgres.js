/**
 * store-postgres.js — Capa de persistencia para coexistenceStore.
 *
 * Sustituye el objeto en memoria por almacenamiento durable.
 * Los tokens se guardan SIEMPRE cifrados (formato v2 de crypto-fixed.js).
 * Nunca se escribe un token en texto plano, ni en la base ni en logs.
 *
 * Decision de diseno: los eventos de webhook NO se persisten.
 * Son diagnosticos, estan limitados a 1000 y se pierden sin consecuencia.
 * Persistir lo critico y solo lo critico reduce la superficie de riesgo.
 *
 * Campo key_fingerprint: permite detectar que la ENCRYPTION_KEY cambio
 * y que los datos ya no son descifrables, en vez de fallar en silencio.
 */

const { createCryptoModule } = require('./crypto-fixed');

const SCHEMA = \`
CREATE TABLE IF NOT EXISTS oauth_sessions (
  state        TEXT PRIMARY KEY,
  data         JSONB       NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS phone_numbers (
  phone                 TEXT PRIMARY KEY,
  phone_number_id       TEXT,
  waba_id               TEXT,
  business_portfolio_id TEXT,
  status                TEXT,
  data                  JSONB       NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS business_tokens (
  phone            TEXT PRIMARY KEY,
  encrypted_token  TEXT        NOT NULL,
  token_type       TEXT,
  expires_at       TIMESTAMPTZ,
  key_fingerprint  TEXT        NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON oauth_sessions (expires_at);
\`;

function createStore({ pool, encryptionKey }) {
  // Falla al arrancar si la clave no es valida. Deliberado.
  const cm = createCryptoModule(encryptionKey);

  async function init() {
    await pool.query(SCHEMA);
    return { ok: true, keyFingerprint: cm.keyFingerprint };
  }

  // ---------- Sesiones OAuth (temporales, con expiracion) ----------
  async function saveSession(state, data, expiresAt) {
    await pool.query(
      `INSERT INTO oauth_sessions (state, data, expires_at) VALUES ($1,$2,$3)
       ON CONFLICT (state) DO UPDATE SET data=$2, expires_at=$3`,
      [state, JSON.stringify(data), expiresAt]
    );
  }
  async function getSession(state) {
    const r = await pool.query(
      `SELECT data, expires_at FROM oauth_sessions WHERE state=$1`, [state]);
    if (!r.rows.length) return null;
    if (new Date() > new Date(r.rows[0].expires_at)) {
      await deleteSession(state);
      return null; // expirada: se trata como inexistente
    }
    return r.rows[0].data;
  }
  async function deleteSession(state) {
    await pool.query(`DELETE FROM oauth_sessions WHERE state=$1`, [state]);
  }
  async function purgeExpiredSessions() {
    const r = await pool.query(`DELETE FROM oauth_sessions WHERE expires_at < now()`);
    return r.rowCount;
  }

  // ---------- Numeros vinculados (persistencia permanente) ----------
  async function savePhoneNumber(phone, obj) {
    await pool.query(
      `INSERT INTO phone_numbers
         (phone, phone_number_id, waba_id, business_portfolio_id, status, data, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (phone) DO UPDATE SET
         phone_number_id=$2, waba_id=$3, business_portfolio_id=$4,
         status=$5, data=$6, updated_at=now()`,
      [phone, obj.phone_number_id || null, obj.wabaId || null,
       obj.businessPortfolioId || null, obj.status || null, JSON.stringify(obj)]
    );
  }
  async function getPhoneNumber(phone) {
    const r = await pool.query(`SELECT data FROM phone_numbers WHERE phone=$1`, [phone]);
    return r.rows.length ? r.rows[0].data : null;
  }

  // ---------- Tokens de negocio (SIEMPRE cifrados) ----------
  async function saveToken(phone, plaintextToken, expiresAt, type = 'access_token') {
    // Guarda: nunca sobrescribir un token valido con datos incompletos.
    if (typeof plaintextToken !== 'string' || plaintextToken.trim().length < 10) {
      throw new Error('saveToken rechazado: token vacio o demasiado corto.');
    }
    const encrypted = cm.encryptToken(plaintextToken); // nunca se guarda en claro
    await pool.query(
      `INSERT INTO business_tokens
         (phone, encrypted_token, token_type, expires_at, key_fingerprint, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (phone) DO UPDATE SET
         encrypted_token=$2, token_type=$3, expires_at=$4,
         key_fingerprint=$5, updated_at=now()`,
      [phone, encrypted, type, expiresAt || null, cm.keyFingerprint]
    );
  }

  /**
   * Devuelve { token, expired, keyMismatch } sin lanzar.
   * keyMismatch=true significa que la ENCRYPTION_KEY cambio y el dato
   * quedo irrecuperable: hay que detectarlo, no ignorarlo.
   */
  async function getToken(phone) {
    const r = await pool.query(
      `SELECT encrypted_token, expires_at, key_fingerprint, token_type
         FROM business_tokens WHERE phone=$1`, [phone]);
    if (!r.rows.length) return null;
    const row = r.rows[0];
    if (row.key_fingerprint !== cm.keyFingerprint) {
      return { token: null, keyMismatch: true, expired: false, type: row.token_type };
    }
    const token = cm.decryptToken(row.encrypted_token);
    const expired = row.expires_at ? new Date() > new Date(row.expires_at) : false;
    return { token, keyMismatch: false, expired, type: row.token_type,
             expiresAt: row.expires_at || null };
  }

  // ---------- Metricas para /health y /webhooks/status ----------
  async function counts() {
    const s = await pool.query(`SELECT count(*)::int n FROM oauth_sessions WHERE expires_at > now()`);
    const p = await pool.query(`SELECT count(*)::int n FROM phone_numbers`);
    const t = await pool.query(`SELECT count(*)::int n FROM business_tokens`);
    return { activeSessions: s.rows[0].n, linkedPhoneNumbers: p.rows[0].n, storedTokens: t.rows[0].n };
  }

  return { init, saveSession, getSession, deleteSession, purgeExpiredSessions,
           savePhoneNumber, getPhoneNumber, saveToken, getToken, counts,
           keyFingerprint: cm.keyFingerprint };
}

module.exports = { createStore, SCHEMA };
