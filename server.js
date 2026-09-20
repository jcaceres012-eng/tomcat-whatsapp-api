/**
 * server.js — Tomcat WhatsApp Coexistence API v3.0.0
 * 
 * Servidor Express que integra:
 * - Persistencia PostgreSQL de tokens, números y sesiones
 * - Cifrado AES-256-CBC con IV aleatorio por operación
 * - Probes de salud (liveness y readiness)
 * - API de coexistencia WhatsApp
 * 
 * Arquitectura fail-closed:
 * 1. initPersistence() se ejecuta ANTES de app.listen()
 * 2. Si la BD falla, el proceso termina inmediatamente
 * 3. No hay estado parcial o corrupción
 */

import express from 'express';
import dotenv from 'dotenv';
import { initPersistence, getStore } from './persistence.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let isReady = false;

// ============================================================================
// ENDPOINTS DE DIAGNOSTICO
// ============================================================================

/**
 * /health — Liveness probe (Kubernetes)
 * Devuelve 200 si el proceso corre. No valida conexión a BD.
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'alive', version: '3.0.0', timestamp: new Date().toISOString() });
});

/**
 * /ready — Readiness probe (Kubernetes)
 * Devuelve 200 solo si la persistencia está lista.
 */
app.get('/ready', (req, res) => {
  if (!isReady) {
    return res.status(503).json({ status: 'not_ready' });
  }
  const store = getStore();
  res.status(200).json({
    status: 'ready',
    database: 'connected',
    encryption: { keyFingerprint: store.keyFingerprint }
  });
});

// ============================================================================
// ENDPOINTS DE API
// ============================================================================

/**
 * /coexistence/status
 * Devuelve métricas y estado general.
 */
app.get('/coexistence/status', async (req, res) => {
  try {
    const store = getStore();
    const counts = await store.counts();
    res.json({
      status: 'operational',
      version: '3.0.0',
      metrics: counts,
      encryption: { keyFingerprint: store.keyFingerprint }
    });
  } catch (err) {
    console.error('[coexistence/status] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /coexistence/oauth/session
 * Inicia sesión OAuth. Guarda state en tabla oauth_sessions.
 */
app.post('/coexistence/oauth/session', async (req, res) => {
  try {
    const { state, businessAccountId, redirectUri } = req.body;
    if (!state || !businessAccountId) {
      return res.status(400).json({ error: 'state y businessAccountId requeridos' });
    }

    const store = getStore();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    await store.saveSession(state, { businessAccountId, redirectUri }, expiresAt);
    
    res.status(201).json({ state, expiresAt });
  } catch (err) {
    console.error('[coexistence/oauth/session] Error:', err.message);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * GET /coexistence/oauth/session/:state
 * Valida y devuelve sesión OAuth.
 */
app.get('/coexistence/oauth/session/:state', async (req, res) => {
  try {
    const { state } = req.params;
    const store = getStore();
    const session = await store.getSession(state);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(session);
  } catch (err) {
    console.error('[coexistence/oauth/session/:state] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

/**
 * POST /coexistence/phone-number
 * Registra un número de teléfono vinculado.
 */
app.post('/coexistence/phone-number', async (req, res) => {
  try {
    const { phone, phoneNumberId, wabaId, businessPortfolioId, status } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'phone requerido' });
    }

    const store = getStore();
    await store.savePhoneNumber(phone, phoneNumberId, wabaId, businessPortfolioId, status);
    
    res.status(201).json({ phone, status: 'registered' });
  } catch (err) {
    console.error('[coexistence/phone-number] Error:', err.message);
    res.status(500).json({ error: 'Failed to register phone' });
  }
});

/**
 * GET /coexistence/phone-number/:phone
 * Devuelve datos del número registrado.
 */
app.get('/coexistence/phone-number/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const store = getStore();
    const phoneData = await store.getPhoneNumber(phone);
    
    if (!phoneData) {
      return res.status(404).json({ error: 'Phone number not found' });
    }
    res.json(phoneData);
  } catch (err) {
    console.error('[coexistence/phone-number/:phone] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch phone number' });
  }
});

/**
 * POST /coexistence/token
 * Guarda un token de acceso (cifrado con AES-256-CBC).
 */
app.post('/coexistence/token', async (req, res) => {
  try {
    const { phone, token, type, expiresAt } = req.body;
    if (!phone || !token) {
      return res.status(400).json({ error: 'phone y token requeridos' });
    }

    const store = getStore();
    await store.saveToken(phone, token, type || 'access', expiresAt);
    
    res.status(201).json({ phone, status: 'token_stored' });
  } catch (err) {
    console.error('[coexistence/token] Error:', err.message);
    res.status(500).json({ error: 'Failed to store token' });
  }
});

/**
 * GET /coexistence/token/:phone
 * Obtiene y desencripta un token.
 * Detecta cambios en ENCRYPTION_KEY (keyMismatch).
 */
app.get('/coexistence/token/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const store = getStore();
    const result = await store.getToken(phone);
    
    if (!result) {
      return res.status(404).json({ error: 'Token not found' });
    }
    
    if (result.keyMismatch) {
      return res.status(403).json({
        error: 'Key mismatch: encryption key changed, token unrecoverable',
        keyMismatch: true
      });
    }
    
    if (result.expired) {
      return res.status(410).json({ error: 'Token expired', expired: true });
    }
    
    res.json({ token: result.token, type: result.type, expiresAt: result.expiresAt });
  } catch (err) {
    console.error('[coexistence/token/:phone] Error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve token' });
  }
});

/**
 * DELETE /coexistence/token/:phone
 * Consume/revoca un token.
 */
app.delete('/coexistence/token/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const store = getStore();
    
    // Obtener el token antes de borrarlo (para validar que existe)
    const result = await store.getToken(phone);
    if (!result) {
      return res.status(404).json({ error: 'Token not found' });
    }
    
    // Borrar la fila
    // Nota: store-postgres.js no exporta deleteToken. Usamos saveToken con null.
    // Para una API REST, consumir = borrar.
    await store.saveToken(phone, '', 'revoked', new Date());
    
    res.status(204).send();
  } catch (err) {
    console.error('[DELETE /coexistence/token/:phone] Error:', err.message);
    res.status(500).json({ error: 'Failed to revoke token' });
  }
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err, req, res, next) => {
  console.error('[error handler]', err);
  res.status(500).json({ error: 'Unhandled error' });
});

// ============================================================================
// STARTUP — FAIL-CLOSED ARCHITECTURE
// ============================================================================

async function start() {
  try {
    console.log('[server] Inicializando persistencia...');
    await initPersistence();
    isReady = true;
    console.log('[server] Persistencia lista ✓');
  } catch (err) {
    console.error('[server] ERROR de inicialización:', err.message);
    process.exit(1); // FAIL-CLOSED: terminar si la BD falla
  }

  try {
    app.listen(PORT, () => {
      console.log(`[server] Escuchando en puerto ${PORT}`);
      console.log('[server] Tomcat WhatsApp Coexistence API v3.0.0 en línea');
    });
  } catch (err) {
    console.error('[server] ERROR al iniciar Express:', err.message);
    process.exit(1);
  }
}

// Ejecutar
start().catch(err => {
  console.error('[server] Startup error:', err);
  process.exit(1);
});

export default app;
