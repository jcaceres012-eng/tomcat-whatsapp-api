/**
 * WhatsApp Coexistence Backend - Tomcat Store
 *
 * FUNCIONALIDAD:
 * ✅ Webhook receiver (Cloud API messages)
 * ✅ Meta Conversions API (business messaging / WhatsApp)
 * ✅ Embedded Signup flow (Hosted)
 * ✅ OAuth callback handling
 * ✅ Automatic Events API webhooks
 * ✅ Token encryption & secure storage
 * ✅ Coexistence status tracking
 *
 * FLUJO DE COEXISTENCE:
 * 1. GET /coexistence/start → Inicia flujo Embedded Signup
 * 2. Usuario autoriza en Meta
 * 3. Meta redirige a GET /coexistence/callback
 * 4. Backend captura phone_number_id
 * 5. Backend valida y almacena credenciales
 * 6. Coexistence activado ✅
 */

// ============================================
// WhatsApp Coexistence Backend - Version 3.0.0
// Persistencia PostgreSQL integrada
// ============================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { createPersistence } = require('./persistence');
const { createCapi } = require('./capi');
const app = express();

app.use(express.json());

// ============================================
// STATIC FILES - Servir archivos públicos (HTML, CSS, JS)
// ============================================
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// CONFIGURACIÓN CRÍTICA
// ============================================

const port = process.env.PORT || 3000;
const nodeEnv = process.env.NODE_ENV || 'development';

// Meta API
// ID público de la app "Tomcat Store" (el mismo que usa la página de Embedded Signup).
// Se fija aquí porque la variable META_APP_ID en Render apuntaba a otra app ("Invalid Client ID").
const EXPECTED_META_APP_ID = '949332344257619';
const envMetaAppId = (process.env.META_APP_ID || '').trim();
const metaAppId = EXPECTED_META_APP_ID;
const metaAppSecret = (process.env.META_APP_SECRET || '').trim();
const metaAccessToken = process.env.META_ACCESS_TOKEN;
const businessPortfolioId = process.env.BUSINESS_PORTFOLIO_ID || '603733427671323';
const targetWabaId = process.env.TARGET_WABA_ID || '28291929163801429';
const targetPhoneNumber = process.env.TARGET_PHONE_NUMBER || '+50488447759';

// Webhook
const verifyToken = (process.env.VERIFY_TOKEN || '').trim();
const webhookUrl = process.env.WEBHOOK_URL || 'https://tomcat-whatsapp-api.onrender.com';

// Meta Conversions API (mensajería de WhatsApp)
// CAPI_DATASET_ID / CAPI_ACCESS_TOKEN tienen prioridad; PIXEL_ID / PIXEL_ACCESS_TOKEN se aceptan por compatibilidad.
const capiDatasetId = process.env.CAPI_DATASET_ID || process.env.PIXEL_ID;
const capiAccessToken = process.env.CAPI_ACCESS_TOKEN || process.env.PIXEL_ACCESS_TOKEN;
const graphApiVersion = process.env.GRAPH_API_VERSION || 'v25.0';

// Admin Security - MUST be set in environment variables
const adminApiKey = process.env.ADMIN_API_KEY;

// Encryption
const encryptionKey = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

// ============================================
// PERSISTENCIA POSTGRESQL
// ============================================

let persistence = null;

// Storage en memoria para webhooks (no persistidos)
const coexistenceStore = {
  sessions: {},           // MIGRANDO a base de datos
  phoneNumbers: {},       // MIGRANDO a base de datos
  tokens: {},             // MIGRANDO a base de datos (read-only cache)
  webhookEvents: []       // Histórico de eventos (no persistido, máx 1000)
};

// Inicializar persistencia en arranque
async function initPersistence() {
  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.warn('DATABASE_URL no configurada. Usando solo almacenamiento en memoria.');
      return;
    }

    persistence = createPersistence({
      databaseUrl,
      encryptionKey,
      logger: logEvent
    });

    await persistence.init();
    logEvent('PERSISTENCE_INITIALIZED', { ok: true });

    // Hidratar store con datos de la base
    const hydrateResult = await persistence.hydrate(coexistenceStore, targetPhoneNumber);
    logEvent('PERSISTENCE_HYDRATED', hydrateResult);
  } catch (error) {
    logEvent('PERSISTENCE_INIT_ERROR', { error: error.message });
    throw error;
  }
}

// ============================================
// HELPER: OBTENER TOKEN CON VALIDACIÓN
// ============================================

async function getCoexistenceToken(phone) {
  if (!persistence) {
    // Fallback: usar token estático si no hay persistencia
    return { token: metaAccessToken, expired: false, keyMismatch: false };
  }

  const result = await persistence.getTokenPlaintext(phone);

  if (!result) {
    return { token: null, expired: false, keyMismatch: false, error: 'No token found' };
  }

  if (result.keyMismatch) {
    return { token: null, expired: false, keyMismatch: true, error: 'Encryption key mismatch' };
  }

  if (result.expired) {
    return { token: null, expired: true, keyMismatch: false, error: 'Token expired' };
  }

  return { token: result.token, expired: false, keyMismatch: false };
}

// ============================================
// LOGGING MEJORADO
// ============================================

const logEvent = (type, data) => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    type,
    timestamp,
    data,
    environment: nodeEnv,
    service: 'tomcat-whatsapp-api'
  };

  console.log(`\n[${ type }] ${timestamp}`);
  console.log(JSON.stringify(logEntry, null, 2));

  // Guardar en histórico (máximo 1000 eventos)
  if (coexistenceStore.webhookEvents.length > 1000) {
    coexistenceStore.webhookEvents.shift();
  }
  coexistenceStore.webhookEvents.push(logEntry);
};

// ============================================
// META CONVERSIONS API (WhatsApp)
// ============================================

const capi = createCapi({
  datasetId: capiDatasetId,
  accessToken: capiAccessToken,
  graphVersion: graphApiVersion,
  testEventCode: process.env.CAPI_TEST_EVENT_CODE,
  defaultWabaId: targetWabaId,
  logger: logEvent
});

// ============================================
// ENDPOINT: HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  // Liveness probe: solo verifica que el proceso responde
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'tomcat-whatsapp-api',
    environment: nodeEnv,
    uptime: process.uptime(),
    version: '3.0.0'
  });
});

// ============================================
// ENDPOINT: READINESS CHECK
// ============================================

app.get('/ready', async (req, res) => {
  // Readiness probe: verifica persistencia, hidratación, estado de encriptación
  try {
    let checks = {
      database: false,
      hydrated: false,
      encryptionKey: true,
      keyMismatch: false
    };

    if (persistence) {
      const { ready, checks: persistenceChecks } = await persistence.readiness();
      checks = persistenceChecks;

      if (!ready) {
        return res.status(503).json({
          ready: false,
          checks,
          message: 'Sistema no listo'
        });
      }
    }

    res.json({
      ready: true,
      checks,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      ready: false,
      error: error.message
    });
  }
});

// ============================================
// EMBEDDED SIGNUP - INICIO DEL FLUJO
// ============================================

/**
 * GET /coexistence/start
 *
 * Sirve la página HTML de Embedded Signup v4 correcta.
 * FLUJO CORRECTO:
 * - Usa SDK de JavaScript de Facebook
 * - Parámetro: featureType: "whatsapp_business_app_onboarding"
 * - Evento esperado: FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING
 * - NO redirige a OAuth genérico de Facebook
 */
app.get('/coexistence/start', (req, res) => {
  try {
    logEvent('COEXISTENCE_START', {
      message: 'Sirviendo página Embedded Signup v4',
      method: 'JavaScript SDK con featureType',
      targetPhone: targetPhoneNumber
    });

    // Leer la página HTML correcta
    const fs = require('fs');
    const path = require('path');
    const htmlPath = path.join(__dirname, 'public', 'whatsapp-coexistence-embedded-signup-v4.html');

    if (fs.existsSync(htmlPath)) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.sendFile(htmlPath);
    } else {
      // Si no existe el archivo (ej: en producción), devolver HTML inline
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>WhatsApp Coexistence - Conectando...</title>
</head>
<body>
    <div style="text-align: center; padding: 50px; font-family: Arial;">
        <h1>⚠️ Página HTML no disponible</h1>
        <p>El archivo 'whatsapp-coexistence-embedded-signup-v4.html' no se encontró.</p>
        <p>Por favor, asegúrate de que esté en el directorio public/.</p>
        <p style="color: #999; margin-top: 30px;">Backend versión: v2.1 (corrected)</p>
    </div>
</body>
</html>
      `);
    }

  } catch (error) {
    logEvent('COEXISTENCE_START_ERROR', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({
      error: 'Failed to serve Embedded Signup',
      details: error.message
    });
  }
});

// ============================================
// EMBEDDED SIGNUP - CALLBACK DE META
// ============================================

/**
 * GET /coexistence/callback
 *
 * Callback que Meta llama después de autorización exitosa.
 * Captura el phone_number_id del número coexistente.
 *
 * Parámetros esperados:
 * - state: sessionId (para validación CSRF)
 * - phone_number_id: ID del número vinculado
 * - code: Código de autorización (si aplica)
 * - error: Mensaje de error (si falla)
 */
app.get('/coexistence/callback', async (req, res) => {
  try {
    const { state, phone_number_id, code, error, error_description } = req.query;

    logEvent('COEXISTENCE_CALLBACK_RECEIVED', {
      state,
      phone_number_id,
      code: code ? '[REDACTED]' : null,
      error,
      error_description,
      timestamp: new Date().toISOString()
    });

    // ========== VALIDACIÓN DE ESTADO ==========
    if (!state) {
      throw new Error('Missing state parameter (CSRF validation)');
    }

    const session = coexistenceStore.sessions[state];
    if (!session) {
      throw new Error('Invalid or expired session');
    }

    if (new Date() > session.expiresAt) {
      delete coexistenceStore.sessions[state];
      throw new Error('Session expired');
    }

    // ========== MANEJO DE ERRORES META ==========
    if (error) {
      session.status = 'failed';
      session.error = error;
      session.errorDescription = error_description;

      logEvent('COEXISTENCE_CALLBACK_ERROR', {
        sessionId: state,
        error,
        error_description,
        targetPhone: session.targetPhone
      });

      return res.status(400).json({
        success: false,
        message: 'Autorización rechazada',
        error,
        description: error_description,
        sessionId: state,
        nextSteps: 'Intenta nuevamente usando: GET /coexistence/start'
      });
    }

    // ========== VALIDACIÓN DE PHONE NUMBER ID ==========
    if (!phone_number_id) {
      throw new Error('Missing phone_number_id in callback');
    }

    // Validar formato de phone_number_id (debe ser numérico)
    if (!/^\d{15,}$/.test(phone_number_id)) {
      throw new Error(`Invalid phone_number_id format: ${phone_number_id}`);
    }

    // ========== CAPTURAR Y ALMACENAR PHONE NUMBER ID ==========
    session.status = 'authorized';
    session.phoneNumberId = phone_number_id;
    session.authorizedAt = new Date();

    // Guardar phone number en store
    coexistenceStore.phoneNumbers[targetPhoneNumber] = {
      phone: targetPhoneNumber,
      phone_number_id,
      wabaId: targetWabaId,
      businessPortfolioId,
      status: 'active',
      authorizedAt: new Date(),
      coexistenceActive: true,
      capabilities: {
        cloudApi: true,
        businessApp: true,
        messageSyncEnabled: true
      }
    };

    logEvent('PHONE_NUMBER_CAPTURED', {
      phone: targetPhoneNumber,
      phone_number_id,
      wabaId: targetWabaId,
      sessionId: state,
      status: 'authorized'
    });

    // ========== OBTENER ACCESS TOKEN (si Meta proporcionó code) ==========
    let accessToken = null;
    if (code && metaAppSecret) {
      try {
        // CORRECCIÓN: Usar endpoint correcto de Graph API (v25.0)
        // Antes: graph.instagram.com (INCORRECTO para OAuth de Facebook)
        // Ahora: graph.facebook.com/v25.0/oauth/access_token (CORRECTO)
        const tokenResponse = await axios.post(
          'https://graph.facebook.com/v25.0/oauth/access_token',
          {
            client_id: metaAppId,
            client_secret: metaAppSecret,
            grant_type: 'authorization_code',
            redirect_uri: `${webhookUrl}/coexistence/callback`,
            code
          },
          { timeout: 10000 }
        );

        accessToken = tokenResponse.data.access_token;
        const expiresIn = tokenResponse.data.expires_in || 5184000; // 60 días default
        const expiresAt = new Date(Date.now() + expiresIn * 1000);

        // WRITE-AHEAD: Persistir en base ANTES de tocar memoria
        if (persistence) {
          await persistence.persistTokenCritical(
            targetPhoneNumber,
            accessToken,
            expiresAt,
            'access_token'
          );
        }

        // Después de confirmar en base, guardar en memoria (cache)
        coexistenceStore.tokens[targetPhoneNumber] = {
          encryptedToken: '[en base de datos]',
          expiresAt,
          type: 'access_token'
        };

        logEvent('ACCESS_TOKEN_OBTAINED', {
          phone: targetPhoneNumber,
          tokenType: 'access_token',
          expiresIn: expiresIn,
          expiresAt: expiresAt.toISOString(),
          persisted: !!persistence
        });
      } catch (error) {
        logEvent('ACCESS_TOKEN_ERROR', {
          phone: targetPhoneNumber,
          error: error.message,
          severidad: 'critica'
        });
        // CRÍTICO: Este error debe propagarse para indicar fallo en Embedded Signup
        throw new Error('No se pudo obtener o persistir el token de Coexistence. ' +
                        'La vinculacion NO se completo: repita el Embedded Signup.');
      }
    }

    // ========== RESPUESTA EXITOSA ==========
    const responseData = {
      success: true,
      message: 'Coexistence activado ✅',
      sessionId: state,
      phoneNumber: targetPhoneNumber,
      phoneNumberId: phone_number_id,
      wabaId: targetWabaId,
      status: 'active',
      coexistenceFeatures: {
        cloudApi: 'Conectado - Puedes enviar mensajes desde API',
        businessApp: 'Habilitado - Puedes usar WhatsApp Business App',
        messageSync: 'Activo - Mensajes sincronizados entre plataformas',
        webhookReceiver: 'Configurado - Recibiendo eventos en tiempo real'
      },
      nextSteps: [
        '1. Verifica que WhatsApp Business App siga funcionando en tu teléfono',
        '2. Envía un mensaje de prueba desde la app',
        '3. Envía un mensaje de prueba desde la Cloud API',
        '4. Comprueba que ambos aparecen en la conversación',
        '5. Monitorea webhooks en: GET /webhooks/status'
      ],
      webhookReceiver: `${webhookUrl}/`,
      statusUrl: `${webhookUrl}/coexistence/status`,
      logsUrl: `${webhookUrl}/webhooks/logs`
    };

    res.json(responseData);

  } catch (error) {
    logEvent('COEXISTENCE_CALLBACK_EXCEPTION', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      error: 'Callback processing failed',
      message: error.message,
      support: 'Contacta al equipo técnico de Tomcat Store'
    });
  }
});

// ============================================
// EMBEDDED SIGNUP - CALLBACK POST (desde JavaScript SDK)
/**
 * POST /coexistence/exchange-code
 *
 * Intercambia el código de autorización de FB.login con Meta Graph API.
 * El código tiene un TTL de 30 segundos, por lo que debe ser enviado inmediatamente.
 *
 * Body esperado:
 * {
 *   code: "...",           // Código de autorización (30 segundos TTL)
 *   timestamp: "..."       // Timestamp de cuando se recibió
 * }
 *
 * Response:
 * {
 *   success: true,
 *   waba_id: "...",
 *   phone_number_id: "...",
 *   business_token: "..."
 * }
 */
app.post('/coexistence/exchange-code', async (req, res) => {
  const graph = `https://graph.facebook.com/${graphApiVersion}`;
  try {
    const { code, timestamp, session = {} } = req.body || {};

    if (!code) {
      return res.status(400).json({ success: false, error: 'Missing authorization code' });
    }
    if (!metaAppId || !metaAppSecret) {
      logEvent('COEXISTENCE_CONFIG_ERROR', { appIdSet: !!metaAppId, appSecretSet: !!metaAppSecret });
      return res.status(500).json({ success: false, error: 'Server missing META_APP_ID / META_APP_SECRET' });
    }

    const sessionEvent = session.event || null;
    let wabaId = session.waba_id || null;
    let phoneNumberId = session.phone_number_id || null;
    const isBusinessAppOnboarding = sessionEvent === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';

    logEvent('COEXISTENCE_CODE_EXCHANGE_START', {
      timestamp,
      sessionEvent,
      wabaId,
      phoneNumberId
    });

    // Paso 1 (doc oficial Embedded Signup): GET /oauth/access_token con client_id, client_secret y code. Sin redirect_uri.
    const tokenResponse = await axios.get(`${graph}/oauth/access_token`, {
      params: { client_id: metaAppId, client_secret: metaAppSecret, code },
      timeout: 15000
    });
    const businessToken = tokenResponse.data && tokenResponse.data.access_token;
    if (!businessToken) {
      return res.status(502).json({ success: false, error: 'No access token received from Meta' });
    }
    logEvent('COEXISTENCE_TOKEN_EXCHANGED', { tokenLength: businessToken.length });

    const auth = { headers: { Authorization: `Bearer ${businessToken}` }, timeout: 15000 };

    if (!wabaId) {
      logEvent('COEXISTENCE_NO_SESSION_INFO', { sessionEvent });
      return res.status(400).json({
        success: false,
        error: 'Meta no envió el ID de la cuenta de WhatsApp (session info). Repite el proceso sin cerrar la ventana de Meta antes de terminar.'
      });
    }

    // Si el evento de coexistencia no trae phone_number_id, se obtiene de la WABA
    if (!phoneNumberId) {
      const pn = await axios.get(`${graph}/${wabaId}/phone_numbers`, auth);
      const list = (pn.data && pn.data.data) || [];
      const target = String(targetPhoneNumber || '').replace(/\D/g, '');
      const match = list.find(p => String(p.display_phone_number || '').replace(/\D/g, '') === target) || list[0];
      phoneNumberId = match ? match.id : null;
    }
    if (!phoneNumberId) {
      return res.status(400).json({ success: false, error: 'No phone number found in WABA' });
    }

    // Paso 2: suscribir la app a los webhooks de la WABA
    await axios.post(`${graph}/${wabaId}/subscribed_apps`, {}, auth);
    logEvent('COEXISTENCE_APP_SUBSCRIBED', { wabaId });

    // Paso 3: en coexistencia NO se registra el número (ya está registrado en la app). Se sincronizan contactos e historial (una sola vez, dentro de 24 h).
    const sync = {};
    if (isBusinessAppOnboarding) {
      for (const syncType of ['smb_app_state_sync', 'history']) {
        try {
          const r = await axios.post(`${graph}/${phoneNumberId}/smb_app_data`,
            { messaging_product: 'whatsapp', sync_type: syncType }, auth);
          sync[syncType] = { ok: true, request_id: r.data && r.data.request_id };
        } catch (e) {
          sync[syncType] = { ok: false, message: e.response?.data?.error?.message || e.message };
        }
      }
      logEvent('COEXISTENCE_SYNC_REQUESTED', sync);
    }

    // Paso 4: guardar el token cifrado en la base de datos (nunca se devuelve al navegador)
    let persisted = false;
    if (persistence) {
      try {
        await persistence.persistTokenCritical(phoneNumberId, businessToken, null, 'business_token');
        persisted = true;
      } catch (e) {
        logEvent('COEXISTENCE_TOKEN_PERSIST_ERROR', { message: e.message });
      }
    }
    coexistenceStore.tokens[phoneNumberId] = businessToken;
    coexistenceStore.phoneNumbers[phoneNumberId] = {
      phone_number_id: phoneNumberId,
      wabaId,
      businessPortfolioId: session.business_id || businessPortfolioId,
      status: 'active',
      authorizedAt: new Date(),
      coexistenceActive: isBusinessAppOnboarding,
      completedVia: sessionEvent || 'embedded_signup_v4'
    };

    logEvent('COEXISTENCE_ACTIVATED', { wabaId, phoneNumberId, sessionEvent, persisted });

    return res.json({
      success: true,
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
      coexistenceActive: isBusinessAppOnboarding,
      sync,
      persisted
    });
  } catch (error) {
    const metaError = error.response?.data?.error;
    logEvent('COEXISTENCE_EXCHANGE_CODE_ERROR', {
      appIdUsed: metaAppId,
      envMetaAppIdMatches: envMetaAppId === EXPECTED_META_APP_ID,
      appSecretLength: metaAppSecret.length,
      status: error.response?.status || null,
      message: metaError?.message || error.message,
      code: metaError?.code || null,
      subcode: metaError?.error_subcode || null,
      fbtraceId: metaError?.fbtrace_id || null
    });
    return res.status(500).json({
      success: false,
      error: metaError?.message || 'Code exchange failed'
    });
  }
});

// ============================================

/**
 * POST /coexistence/callback
 *
 * Callback POST desde la página HTML con SDK de JavaScript.
 * Recibe los datos del evento FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING.
 *
 * Body esperado:
 * {
 *   event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
 *   waba_id: "...",
 *   phone_number_id: "...",
 *   timestamp: "..."
 * }
 */
app.post('/coexistence/callback', async (req, res) => {
  try {
    const { event, waba_id, phone_number_id, timestamp } = req.body;

    logEvent('COEXISTENCE_CALLBACK_POST', {
      event,
      waba_id,
      phone_number_id,
      timestamp
    });

    // Validar evento esperado
    if (event !== 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
      return res.status(400).json({
        success: false,
        error: 'Invalid event',
        message: `Expected FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING but got ${event}`
      });
    }

    // Validar phone_number_id
    if (!phone_number_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing phone_number_id'
      });
    }

    // Almacenar datos de Coexistence
    coexistenceStore.phoneNumbers[targetPhoneNumber] = {
      phone: targetPhoneNumber,
      phone_number_id,
      wabaId: waba_id || targetWabaId,
      businessPortfolioId,
      status: 'active',
      authorizedAt: new Date(timestamp) || new Date(),
      coexistenceActive: true,
      completedVia: 'embedded_signup_v4_javascript_sdk',
      capabilities: {
        cloudApi: true,
        businessApp: true,
        messageSyncEnabled: true
      }
    };

    logEvent('COEXISTENCE_ACTIVATED_VIA_SDK', {
      phone: targetPhoneNumber,
      phone_number_id,
      wabaId: waba_id,
      method: 'JavaScript SDK',
      event
    });

    // Respuesta exitosa
    res.json({
      success: true,
      message: 'Coexistence completado exitosamente ✅',
      phoneNumber: targetPhoneNumber,
      phoneNumberId: phone_number_id,
      wabaId: waba_id,
      status: 'active',
      coexistenceActive: true,
      features: {
        cloudApi: 'Habilitado',
        businessApp: 'Habilitado',
        messageSyncEnabled: 'Activo'
      }
    });

  } catch (error) {
    logEvent('COEXISTENCE_CALLBACK_POST_ERROR', {
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      error: 'POST callback processing failed',
      message: error.message
    });
  }
});

// ============================================
// COEXISTENCE STATUS
// ============================================

/**
 * GET /coexistence/status
 *
 * Retorna el estado actual de Coexistence para el número objetivo.
 */
app.get('/coexistence/status', (req, res) => {
  const phoneData = coexistenceStore.phoneNumbers[targetPhoneNumber];

  if (!phoneData) {
    return res.json({
      status: 'not_configured',
      phone: targetPhoneNumber,
      message: 'Coexistence no está configurado. Ejecuta: GET /coexistence/start',
      configUrl: `${webhookUrl}/coexistence/start`
    });
  }

  res.json({
    status: 'active',
    phone: targetPhoneNumber,
    phoneNumberId: phoneData.phone_number_id,
    wabaId: phoneData.wabaId,
    authorizedAt: phoneData.authorizedAt,
    coexistenceFeatures: phoneData.capabilities,
    messageSyncStatus: 'enabled',
    lastUpdate: new Date().toISOString(),
    operationalStatus: {
      cloudApi: 'Active ✅',
      businessApp: 'Active ✅',
      webhookReceiver: `Active at ${webhookUrl}/ ✅`,
      pixelIntegration: capi.enabled ? 'Active ✅' : 'Not configured'
    }
  });
});

// ============================================
// WEBHOOK VERIFICATION (GET)
// ============================================

app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;

  if (mode === 'subscribe' && verifyToken && token === verifyToken) {
    logEvent('WEBHOOK_VERIFIED', {
      mode,
      verifyTokenMatch: true,
      timestamp: new Date().toISOString()
    });
    res.status(200).send(challenge);
  } else {
    logEvent('WEBHOOK_VERIFICATION_FAILED', {
      mode,
      tokenReceived: Boolean(token),
      tokenMatch: false,
      challenge: !!challenge
    });
    res.status(403).end();
  }
});

// ============================================
// WEBHOOK EVENTS (POST)
// ============================================

app.post('/', (req, res) => {
  const { entry } = req.body;

  // Respuesta inmediata a Meta
  res.status(200).json({ success: true });

  if (!entry) return;

  entry.forEach((item) => {
    const { changes } = item;

    changes.forEach(async (change) => {
      const { field, value } = change;

      // ========== MENSAJES ENTRANTES ==========
      if (field === 'messages') {
        const { messages, metadata } = value;

        messages?.forEach(async (message) => {
          // No registrar teléfono completo ni texto: /webhooks/status es público
          logEvent('MESSAGE_RECEIVED', {
            from: capi.maskPhone(message.from),
            type: message.type,
            messageId: message.id,
            timestamp: message.timestamp,
            phoneNumberId: metadata.phone_number_id,
            coexistenceMode: true,
            source: message.from_me ? 'BUSINESS_APP' : 'CLOUD_API',
            fromAd: Boolean(message.referral && message.referral.ctwa_clid)
          });

          // API de Conversiones: solo conversaciones iniciadas desde un anuncio clic a WhatsApp
          if (!message.from_me) {
            const click = capi.rememberClick(message, item.id);
            if (click) {
              await capi.sendEvent('LeadSubmitted', {
                phone: message.from,
                ctwaClid: click.ctwaClid,
                wabaId: click.wabaId,
                eventId: `lead_${message.id}`
              });
            }
          }
        });
      }

      // ========== ESTADO DE MENSAJES ==========
      if (field === 'message_status') {
        const { statuses } = value;
        statuses?.forEach((status) => {
          logEvent('MESSAGE_STATUS', {
            messageId: status.id,
            status: status.status,
            timestamp: status.timestamp,
            phoneNumberId: value.metadata?.phone_number_id,
            recipientId: capi.maskPhone(status.recipient_id)
          });
        });
      }

      // ========== ACTUALIZACIONES DE PLANTILLAS ==========
      if (field === 'message_template_status_update') {
        logEvent('TEMPLATE_STATUS_UPDATE', value);
      }

      // ========== ALERTAS DE CUENTA (IMPORTANTE PARA COEXISTENCE) ==========
      if (field === 'account_alerts') {
        logEvent('ACCOUNT_ALERT', value);
      }

      // ========== AUTOMATIC EVENTS API - COEXISTENCE EVENTS ==========
      if (field === 'coexistence_updates') {
        logEvent('COEXISTENCE_EVENT', {
          eventType: value.event_type,
          phone: value.phone_number,
          quality: value.quality_rating,
          timestamp: new Date().toISOString()
        });
      }
    });
  });
});

// ============================================
// CONVERSIONES MANUALES (ventas cerradas por WhatsApp)
// ============================================

function isAdminAuthorized(req) {
  const providedKey = req.headers['x-admin-key'];
  if (!adminApiKey || !providedKey) return false;
  const a = Buffer.from(String(providedKey));
  const b = Buffer.from(String(adminApiKey));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * POST /conversions/event
 * Header: x-admin-key: <ADMIN_API_KEY>
 * Body: { "phone": "50499998888", "event": "Purchase", "value": 3700, "currency": "HNL" }
 *
 * Registra una venta (u otro evento admitido) de un cliente que llegó por un anuncio
 * clic a WhatsApp en los últimos 7 días. "event" es opcional (por defecto Purchase).
 */
app.post('/conversions/event', async (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { phone, ctwa_clid: ctwaClid, event = 'Purchase', value, currency = 'HNL' } = req.body || {};
  if (!phone && !ctwaClid) {
    return res.status(400).json({ ok: false, error: 'phone_or_ctwa_clid_required' });
  }

  const result = await capi.sendEvent(event, { phone, ctwaClid, value, currency });
  const httpStatus = result.ok ? 200
    : result.reason === 'not_configured' ? 503
    : result.reason === 'no_ctwa_clid' ? 404
    : result.reason === 'meta_error' ? 502
    : 400;
  return res.status(httpStatus).json(result);
});

/**
 * GET /conversions/status
 * Estado de la integración (sin exponer credenciales).
 */
app.get('/conversions/status', (req, res) => {
  res.json(capi.status());
});

// ============================================
// UTILIDADES
// ============================================

function getMessageContent(message) {
  const { type, text } = message;
  return {
    type,
    content: text?.body || '[Media]'
  };
}

// ============================================
// LOGS Y DEBUGGING
// ============================================

/**
 * GET /webhooks/logs
 *
 * Retorna los últimos eventos registrados.
 */
app.get('/webhooks/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logs = coexistenceStore.webhookEvents.slice(-limit);

  res.json({
    total: coexistenceStore.webhookEvents.length,
    limit,
    logs,
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /webhooks/status
 *
 * Estado completo del sistema.
 */
app.get('/webhooks/status', (req, res) => {
  res.json({
    service: 'tomcat-whatsapp-api',
    environment: nodeEnv,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    configuration: {
      webhook: 'Configured',
      metaPixel: capi.enabled ? 'Configured' : 'Not configured',
      conversionsApi: capi.status(),
      coexistence: metaAccessToken ? 'Ready' : 'Awaiting Embedded Signup'
    },
    activeSessions: Object.keys(coexistenceStore.sessions).length,
    linkedPhoneNumbers: Object.keys(coexistenceStore.phoneNumbers).length,
    eventCount: coexistenceStore.webhookEvents.length,
    recentEvents: coexistenceStore.webhookEvents.slice(-10)
  });
});

// ============================================
// ADMIN ENDPOINTS - DEREGISTER PHONE NUMBER (TEMPORAL)
// ============================================

/**
 * GET /admin/deregister-status
 * Obtiene el estado actual de números de teléfono en la WABA
 */
app.get('/admin/deregister-status', async (req, res) => {
  // Validate admin API key from environment
  if (!adminApiKey) {
    return res.status(500).json({ error: 'Admin API key not configured' });
  }

  const providedKey = req.query.key || req.headers['x-admin-key'];
  if (providedKey !== adminApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    logEvent('ADMIN_DEREGISTER_STATUS_REQUESTED', {
      timestamp: new Date().toISOString(),
      targetWaba: targetWabaId
    });

    // Obtener token de Coexistence de la base de datos
    const tokenData = await getCoexistenceToken(targetPhoneNumber);
    const accessToken = tokenData.token || metaAccessToken;

    if (tokenData.keyMismatch) {
      return res.status(409).json({
        error: 'Token key mismatch',
        message: 'La clave de encriptación cambió. Token irrecuperable.',
        action: 'Repite Embedded Signup'
      });
    }

    if (tokenData.expired) {
      return res.status(409).json({
        error: 'Token expired',
        message: 'El token de Coexistence está caducado.',
        action: 'Repite Embedded Signup'
      });
    }

    if (!accessToken) {
      return res.status(409).json({
        error: 'No token available',
        message: 'No hay token de Coexistence configurado.',
        action: 'Completa Embedded Signup'
      });
    }

    // Obtener números de teléfono actuales
    const phoneNumbersResponse = await axios.get(
      `https://graph.facebook.com/v25.0/${targetWabaId}/phone_numbers`,
      {
        params: {
          fields: 'id,display_phone_number,status,verified_name,quality_rating,messaging_limit_tier',
          access_token: accessToken
        }
      }
    );

    const phoneNumbers = phoneNumbersResponse.data.data || [];
    const backup = {
      timestamp: new Date().toISOString(),
      action: 'PRE-DEREGISTRATION_STATUS',
      wabaId: targetWabaId,
      phoneNumbers: phoneNumbers,
      targetPhoneNumber: targetPhoneNumber,
      status: 'READY_FOR_DEREGISTER'
    };

    // Guardar backup
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    fs.writeFileSync(
      path.join(backupDir, `backup-${Date.now()}.json`),
      JSON.stringify(backup, null, 2)
    );

    logEvent('ADMIN_PHONE_NUMBERS_RETRIEVED', {
      count: phoneNumbers.length,
      phoneNumbers: phoneNumbers.map(p => ({
        id: p.id,
        number: p.display_phone_number,
        status: p.status
      }))
    });

    res.json({
      success: true,
      message: 'Números de teléfono obtenidos exitosamente',
      wabaId: targetWabaId,
      phoneNumbers: phoneNumbers,
      backup: backup,
      nextStep: 'Llamar a POST /admin/deregister-number con el phone_number_id'
    });

  } catch (error) {
    logEvent('ADMIN_DEREGISTER_STATUS_ERROR', {
      error: error.message,
      response: error.response?.data
    });

    res.status(500).json({
      success: false,
      error: 'Error obteniendo números',
      message: error.message,
      details: error.response?.data
    });
  }
});

/**
 * POST /admin/deregister-number
 * Desregistra un número de teléfono de Cloud API
 */
app.post('/admin/deregister-number', async (req, res) => {
  // Validate admin API key from environment
  if (!adminApiKey) {
    return res.status(500).json({ error: 'Admin API key not configured' });
  }

  const { phone_number_id, key } = req.body;

  if (key !== adminApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!phone_number_id) {
    return res.status(400).json({ error: 'phone_number_id is required' });
  }

  try {
    logEvent('ADMIN_DEREGISTER_STARTED', {
      phone_number_id,
      targetPhoneNumber,
      timestamp: new Date().toISOString()
    });

    // Obtener token de Coexistence de la base de datos
    const tokenData = await getCoexistenceToken(targetPhoneNumber);
    const accessToken = tokenData.token || metaAccessToken;

    if (tokenData.keyMismatch) {
      return res.status(409).json({
        error: 'Token key mismatch',
        message: 'La clave de encriptación cambió. Token irrecuperable.',
        action: 'Repite Embedded Signup'
      });
    }

    if (tokenData.expired) {
      return res.status(409).json({
        error: 'Token expired',
        message: 'El token de Coexistence está caducado.',
        action: 'Repite Embedded Signup'
      });
    }

    if (!accessToken) {
      return res.status(409).json({
        error: 'No token available',
        message: 'No hay token de Coexistence configurado.',
        action: 'Completa Embedded Signup'
      });
    }

    // DESREGISTRAR NÚMERO
    const deregisterResponse = await axios.post(
      `https://graph.facebook.com/v25.0/${phone_number_id}/deregister`,
      {},
      {
        params: {
          access_token: accessToken
        }
      }
    );

    logEvent('ADMIN_DEREGISTER_SUCCESS', {
      phone_number_id,
      response: deregisterResponse.data,
      timestamp: new Date().toISOString()
    });

    // Documentar desvinculación
    const deregisterRecord = {
      timestamp: new Date().toISOString(),
      action: 'PHONE_NUMBER_DEREGISTERED',
      phone_number_id,
      targetPhoneNumber,
      wabaId: targetWabaId,
      response: deregisterResponse.data,
      status: 'SUCCESS'
    };

    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    fs.writeFileSync(
      path.join(backupDir, `deregister-${Date.now()}.json`),
      JSON.stringify(deregisterRecord, null, 2)
    );

    // Verificar estado post-desregistro
    const postDeregisterStatus = await axios.get(
      `https://graph.facebook.com/v25.0/${targetWabaId}/phone_numbers`,
      {
        params: {
          fields: 'id,display_phone_number,status,verified_name',
          access_token: metaAccessToken
        }
      }
    );

    res.json({
      success: true,
      message: '✅ Número desregistrado exitosamente',
      deregisterResponse: deregisterResponse.data,
      postDeregisterStatus: postDeregisterStatus.data.data || [],
      documentation: {
        timestamp: new Date().toISOString(),
        action: 'PHONE_NUMBER_DEREGISTERED',
        phone_number_id,
        targetPhoneNumber,
        wabaId: targetWabaId,
        status: 'SUCCESS'
      },
      nextSteps: [
        `1. El número ${targetPhoneNumber} ha sido desvinculado de Cloud API`,
        '2. Ahora puedes registrarlo en WhatsApp Business App',
        '3. Después, podrás intentar Coexistence con Embedded Signup v4',
        '4. Monitorea los webhooks en GET /webhooks/logs'
      ]
    });

  } catch (error) {
    logEvent('ADMIN_DEREGISTER_ERROR', {
      phone_number_id,
      error: error.message,
      response: error.response?.data,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      error: 'Error desregistrando número',
      message: error.message,
      details: error.response?.data
    });
  }
});

/**
 * GET /admin/verify-deregister
 * Verifica el estado después de desregistro
 */
app.get('/admin/verify-deregister', async (req, res) => {
  // Validate admin API key from environment
  if (!adminApiKey) {
    return res.status(500).json({ error: 'Admin API key not configured' });
  }

  const providedKey = req.query.key || req.headers['x-admin-key'];
  if (providedKey !== adminApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Obtener token de Coexistence de la base de datos
    const tokenData = await getCoexistenceToken(targetPhoneNumber);
    const accessToken = tokenData.token || metaAccessToken;

    if (!accessToken) {
      return res.status(409).json({
        error: 'No token available',
        message: 'No hay token de Coexistence configurado.'
      });
    }

    const currentStatus = await axios.get(
      `https://graph.facebook.com/v25.0/${targetWabaId}/phone_numbers`,
      {
        params: {
          fields: 'id,display_phone_number,status',
          access_token: accessToken
        }
      }
    );

    const targetNumber = currentStatus.data.data?.find(
      p => p.display_phone_number === targetPhoneNumber
    );

    res.json({
      success: true,
      message: 'Estado actual de WABA',
      wabaId: targetWabaId,
      targetPhoneNumber,
      currentPhoneNumbers: currentStatus.data.data,
      targetNumberStatus: targetNumber || 'NO ENCONTRADO',
      verification: targetNumber ? 'Número aún está en WABA' : '✅ Número desvinculado exitosamente',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data
    });
  }
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((err, req, res, next) => {
  logEvent('UNHANDLED_ERROR', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  res.status(500).json({
    error: 'Internal Server Error',
    message: nodeEnv === 'development' ? err.message : 'An error occurred'
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    availableEndpoints: [
      'GET /health',
      'GET /coexistence/start',
      'GET /coexistence/callback',
      'GET /coexistence/status',
      'POST /',
      'GET /webhooks/logs',
      'GET /webhooks/status'
    ]
  });
});

// ============================================
// INICIO DEL SERVIDOR
// ============================================

// ============================================
// ARRANQUE SECUENCIAL: PERSISTENCIA ANTES DE ESCUCHAR
// ============================================

async function arrancar() {
  try {
    console.log('\n[STARTUP] Inicializando persistencia...');
    await initPersistence();
    console.log('[STARTUP] Persistencia inicializada ✓');

    // Ahora sí, escuchar tráfico
    return new Promise((resolve) => {
        app.listen(port, () => {
          console.log(`\n╔═══════════════════════════════════════════╗`);
          console.log(`║   WhatsApp Coexistence API v3.0.0         ║`);
          console.log(`║   Tomcat Store - Honduras                 ║`);
          console.log(`║   Puerto: ${port}                              ║`);
          console.log(`║   Modo: ${nodeEnv.toUpperCase().padEnd(30)}║`);
          console.log(`║   Persistencia: ${persistence ? 'PostgreSQL' : 'Memory   '}           ║`);
          console.log(`╚═══════════════════════════════════════════╝\n`);

          logEvent('SERVER_STARTED', {
            port,
            environment: nodeEnv,
            persistenceEnabled: !!persistence,
            services: {
              webhookReceiver: 'Active',
              embeddedSignup: 'Ready',
              pixelIntegration: capi.enabled ? 'Active' : 'Disabled',
              coexistenceTarget: targetPhoneNumber
            },
            endpoints: {
              health: '/health',
              ready: '/ready',
              embeddedSignup: '/coexistence/start',
              webhookReceiver: '/',
              status: '/coexistence/status'
            }
          });

          resolve();
        });
      });
  } catch (error) {
    console.error('FALLO DE ARRANQUE (persistencia):', error.message);
    process.exit(1);
  }
}

// Iniciar el servidor
arrancar().then(() => {
  logEvent('PERSISTENCE_READY', { mensaje: 'Sistema listo para recibir tráfico' });
}).catch(error => {
  console.error('Arranque fallido:', error.message);
  process.exit(1);
});

module.exports = app;
