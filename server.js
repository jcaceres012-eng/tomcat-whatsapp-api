const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Credenciales (desde variables de entorno en Render)
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const BUSINESS_ACCOUNT_ID = process.env.BUSINESS_ACCOUNT_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'tomcat_secret_2026';

// Middleware
app.use(express.json());

// ✅ WEBHOOK VERIFICATION (Meta requiere esto)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado correctamente');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Verificación fallida');
    res.status(403).send('Forbidden');
  }
});

// 📨 RECIBIR MENSAJES
app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Meta envía eventos en este formato
  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry[0];
    const changes = entry.changes[0];
    const value = changes.value;

    // 👤 Si hay mensajes entrantes
    if (value.messages) {
      for (const message of value.messages) {
        const phone = message.from;
        const messageText = message.text.body;
        const messageId = message.id;

        console.log(`📱 Mensaje de ${phone}: ${messageText}`);

        // 🤖 AUTO-RESPUESTA SIMPLE
        await enviarMensaje(phone, `
¡Hola! Gracias por contactar a Tomcat Store. 👋

Recibimos tu mensaje: "${messageText}"

Un representante te responderá pronto. 
Para más info: www.tomcatstorehn.com
        `);

        // Marca como leído
        await marcarComoLeido(messageId);
      }
    }

    // ✅ Confirma a Meta que recibiste el evento
    res.status(200).send({ received: true });
  } else {
    res.status(400).send('Invalid');
  }
});

// 📤 FUNCIÓN: Enviar Mensajes
async function enviarMensaje(phoneNumber, messageText) {
  try {
    const url = `https://graph.instagram.com/v18.0/${PHONE_NUMBER_ID}/messages`;
    
    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'text',
      text: { body: messageText }
    }, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });

    console.log(`✅ Mensaje enviado a ${phoneNumber}`);
    return response.data;
  } catch (error) {
    console.error('❌ Error enviando mensaje:', error.response?.data || error.message);
  }
}

// 📤 FUNCIÓN: Enviar Plantilla
async function enviarPlantilla(phoneNumber, nombrePlantilla, parametros) {
  try {
    const url = `https://graph.instagram.com/v18.0/${PHONE_NUMBER_ID}/messages`;
    
    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'template',
      template: {
        name: nombrePlantilla,
        language: { code: 'es_HN' }, // Honduras Spanish
        parameters: {
          body: {
            parameters: parametros.map(p => ({ type: 'text', text: p }))
          }
        }
      }
    }, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });

    console.log(`✅ Plantilla "${nombrePlantilla}" enviada a ${phoneNumber}`);
    return response.data;
  } catch (error) {
    console.error('❌ Error enviando plantilla:', error.response?.data || error.message);
  }
}

// ✔️ FUNCIÓN: Marcar como Leído
async function marcarComoLeido(messageId) {
  try {
    const url = `https://graph.instagram.com/v18.0/${PHONE_NUMBER_ID}/messages`;
    
    await axios.post(url, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId
    }, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });

    console.log(`✔️ Mensaje ${messageId} marcado como leído`);
  } catch (error) {
    console.error('Error marcando como leído:', error.message);
  }
}

// 🧪 ENDPOINT DE PRUEBA
app.get('/test', (req, res) => {
  res.json({ 
    status: 'running ✅',
    phone_id: PHONE_NUMBER_ID,
    timestamp: new Date()
  });
});

// 📡 ENDPOINT: Enviar Mensaje Manual (para pruebas)
app.post('/enviar', express.json(), async (req, res) => {
  const { phone, message } = req.body;
  
  if (!phone || !message) {
    return res.status(400).json({ error: 'Falta phone o message' });
  }

  await enviarMensaje(phone, message);
  res.json({ success: true, phone, message });
});

// 📡 ENDPOINT: Enviar Plantilla Manual
app.post('/enviar-plantilla', express.json(), async (req, res) => {
  const { phone, template, params } = req.body;
  
  if (!phone || !template) {
    return res.status(400).json({ error: 'Falta phone o template' });
  }

  await enviarPlantilla(phone, template, params || []);
  res.json({ success: true, phone, template });
});

// 🚀 INICIAR SERVIDOR
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🚀 Tomcat WhatsApp API Server       ║
║   Puerto: ${PORT}                          ║
║   Status: ✅ CORRIENDO                 ║
╚════════════════════════════════════════╝
  `);
});
