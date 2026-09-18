/**
 * WhatsApp Coexistence Backend - Tomcat Store
 *
 * FUNCIONALIDAD:
 * ✅ Webhook receiver (Cloud API messages)
 * ✅ Meta Pixel Conversions API integration
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
// WhatsApp Coexistence Backend - Version 2.0.1
// ============================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
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
const metaAppId = process.env.META_APP_ID;
const metaAppSecret = process.env.META_APP_SECRET;
const metaAccessToken = process.env.META_ACCESS_TOKEN;
const businessPortfolioId = process.env.BUSINESS_PORTFOLIO_ID || '603733427671323';
const targetWabaId = process.env.TARGET_WABA_ID || '28291929163801429';
const targetPhoneNumber = process.env.TARGET_PHONE_NUMBER || '+50487473359';

// Webhook
const verifyToken = process.env.VERIFY_TOKEN || 'tomcat_webhook_secure_token_v2';
const webhookUrl = process.env.WEBHOOK_URL || 'https://tomcat-whatsapp-api.onrender.com';

// Meta Pixel
const pixelId = process.env.PIXEL_ID;
const pixelAccessToken = process.env.PIXEL_ACCESS_TOKEN;

// Encryption
const encryptionKey = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

// ============================================
// STORAGE EN MEMORIA (Producción: usar DB)
// ============================================

const coexistenceStore = {
  sessions: {},           // Sesiones OAuth en progreso
  phoneNumbers: {},       // Phone numbers vinculados
  tokens: {},             // Tokens encriptados
  webhookEvents: []       // Histórico de eventos
};

// ============================================
// UTILIDADES DE ENCRIPTACIÓN
// ============================================

function encryptToken(token) {
  const cipher = crypto.createCipher('aes-256-cbc', encryptionKey);
  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

function decryptToken(encrypted) {
  try {
    const decipher = crypto.createDecipher('aes-256-cbc', encryptionKey);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error.message);
    return null;
  }
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
// ENDPOINT: HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'tomcat-whatsapp-api',
    environment: nodeEnv,
    webhook: 'Configured',
    pixelEnabled: !!pixelAccessToken,
    coexistenceEnabled: !!metaAccessToken,
    coexistenceStore: {
      activeSessions: Object.keys(coexistenceStore.sessions).length,
      linkedPhoneNumbers: Object.keys(coexistenceStore.phoneNumbers).length,
      recentEvents: coexistenceStore.webhookEvents.length
    }
  });
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

        // Encriptar y almacenar token
        const encryptedToken = encryptToken(accessToken);
        coexistenceStore.tokens[targetPhoneNumber] = {
          encryptedToken,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hora
          type: 'access_token'
        };

        logEvent('ACCESS_TOKEN_OBTAINED', {
          phone: targetPhoneNumber,
          tokenType: 'access_token',
          expiresIn: '1 hour'
        });
      } catch (error) {
        logEvent('ACCESS_TOKEN_ERROR', {
          phone: targetPhoneNumber,
          error: error.message
        });
        // No es crítico si falla - continuar con configuración básica
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
      pixelIntegration: pixelAccessToken ? 'Active ✅' : 'Not configured'
    }
  });
});

// ============================================
// WEBHOOK VERIFICATION (GET)
// ============================================

app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    logEvent('WEBHOOK_VERIFIED', {
      mode,
      verifyTokenMatch: true,
      timestamp: new Date().toISOString()
    });
    res.status(200).send(challenge);
  } else {
    logEvent('WEBHOOK_VERIFICATION_FAILED', {
      receivedToken: token,
      expectedToken: verifyToken,
      mode,
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
          logEvent('MESSAGE_RECEIVED', {
            from: message.from,
            type: message.type,
            messageId: message.id,
            timestamp: message.timestamp,
            phoneNumberId: metadata.phone_number_id,
            coexistenceMode: true,
            source: message.from_me ? 'BUSINESS_APP' : 'CLOUD_API',
            content: getMessageContent(message)
          });

          // Enviar a Meta Pixel
          await sendPixelEvent('Contact', {
            phone: message.from
          });
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
            recipientId: status.recipient_id
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
// ENVÍO A META PIXEL
// ============================================

async function sendPixelEvent(eventName, userData, eventData = {}) {
  if (!pixelId || !pixelAccessToken) return;

  try {
    const payload = {
      data: [{
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        user_data: {
          ph: userData.phone ?
            crypto.createHash('sha256').update(userData.phone).digest('hex') : null
        },
        event_source_url: 'https://www.tomcatstorehn.com',
        action_source: 'website'
      }],
      access_token: pixelAccessToken
    };

    await axios.post(
      `https://graph.facebook.com/v18.0/${pixelId}/events`,
      payload,
      { timeout: 5000 }
    );
  } catch (error) {
    // Log pero no falles
  }
}

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
      metaPixel: pixelAccessToken ? 'Configured' : 'Not configured',
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
 */
app.get('/admin/deregister-status', async (req, res) => {
  const adminKey = req.query.key || req.headers['x-admin-key'];
  if (adminKey !== 'tomcat-admin-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    logEvent('ADMIN_DEREGISTER_STATUS_REQUESTED', { timestamp: new Date().toISOString(), targetWaba: targetWabaId });

    const phoneNumbersResponse = await axios.get(
      `https://graph.facebook.com/v25.0/${targetWabaId}/phone_numbers`,
      { params: { fields: 'id,display_phone_number,status,verified_name,quality_rating', access_token: metaAccessToken } }
    );

    const phoneNumbers = phoneNumbersResponse.data.data || [];
    const backup = { timestamp: new Date().toISOString(), action: 'PRE-DEREGISTRATION_STATUS', wabaId: targetWabaId, phoneNumbers: phoneNumbers, targetPhoneNumber: targetPhoneNumber, status: 'READY_FOR_DEREGISTER' };

    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    fs.writeFileSync(path.join(backupDir, `backup-${Date.now()}.json`), JSON.stringify(backup, null, 2));

    res.json({ success: true, message: 'Números obtenidos ✅', wabaId: targetWabaId, phoneNumbers: phoneNumbers });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message, details: error.response?.data });
  }
});

/**
 * POST /admin/deregister-number
 */
app.post('/admin/deregister-number', async (req, res) => {
  const { phone_number_id, key } = req.body;
  if (key !== 'tomcat-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  if (!phone_number_id) return res.status(400).json({ error: 'phone_number_id required' });

  try {
    logEvent('ADMIN_DEREGISTER_STARTED', { phone_number_id, targetPhoneNumber });

    const deregisterResponse = await axios.post(`https://graph.facebook.com/v25.0/${phone_number_id}/deregister`, {}, { params: { access_token: metaAccessToken } });

    const deregisterRecord = { timestamp: new Date().toISOString(), action: 'PHONE_NUMBER_DEREGISTERED', phone_number_id, targetPhoneNumber, wabaId: targetWabaId, response: deregisterResponse.data, status: 'SUCCESS' };

    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    fs.writeFileSync(path.join(backupDir, `deregister-${Date.now()}.json`), JSON.stringify(deregisterRecord, null, 2));

    const postDeregisterStatus = await axios.get(`https://graph.facebook.com/v25.0/${targetWabaId}/phone_numbers`, { params: { fields: 'id,display_phone_number,status', access_token: metaAccessToken } });

    res.json({ success: true, message: '✅ Número desregistrado', phone_number_id, postDeregisterStatus: postDeregisterStatus.data.data || [] });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message, details: error.response?.data });
  }
});

app.get('/admin/verify-deregister', async (req, res) => {
  const adminKey = req.query.key || req.headers['x-admin-key'];
  if (adminKey !== 'tomcat-admin-2026') return res.status(401).json({ error: 'Unauthorized' });

  try {
    const currentStatus = await axios.get(`https://graph.facebook.com/v25.0/${targetWabaId}/phone_numbers`, { params: { fields: 'id,display_phone_number,status', access_token: metaAccessToken } });
    const targetNumber = currentStatus.data.data?.find(p => p.display_phone_number === targetPhoneNumber);

    res.json({ success: true, wabaId: targetWabaId, currentPhoneNumbers: currentStatus.data.data, verification: targetNumber ? 'Aún en WABA' : '✅ Desvinculado' });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message, details: error.response?.data });
  }
});



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

app.listen(port, () => {
  console.log(`\n╔═══════════════════════════════════════════╗`);
  console.log(`║   WhatsApp Coexistence API                ║`);
  console.log(`║   Tomcat Store - Honduras                 ║`);
  console.log(`║   Puerto: ${port}                              ║`);
  console.log(`║   Modo: ${nodeEnv.toUpperCase().padEnd(30)}║`);
  console.log(`╚═══════════════════════════════════════════╝\n`);

  logEvent('SERVER_STARTED', {
    port,
    environment: nodeEnv,
    services: {
      webhookReceiver: 'Active',
      embeddedSignup: 'Ready',
      pixelIntegration: pixelAccessToken ? 'Active' : 'Disabled',
      coexistenceTarget: targetPhoneNumber
    },
    endpoints: {
      health: '/health',
      embeddedSignup: '/coexistence/start',
      webhookReceiver: '/',
      status: '/coexistence/status'
    }
  });
});

module.exports = app;
