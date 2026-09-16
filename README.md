# 🚀 Tomcat Store - WhatsApp Business API Server

Servidor Node.js + Express para integrar WhatsApp Business API de Meta con Tomcat Store.

## 📋 Características

- ✅ Recibir mensajes automáticamente
- ✅ Enviar respuestas automáticas
- ✅ Usar plantillas de WhatsApp
- ✅ Marcar mensajes como leídos
- ✅ API REST para enviar mensajes manuales

## 🔧 Instalación Local

```bash
# Instalar dependencias
npm install

# Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# Ejecutar en desarrollo
npm run dev
```

## 🌐 Endpoints

- `GET /test` - Verificar que el servidor está corriendo
- `GET /webhook` - Verificación de Meta
- `POST /webhook` - Recibir eventos de WhatsApp
- `POST /enviar` - Enviar mensaje manual
- `POST /enviar-plantilla` - Enviar plantilla

## 📦 Despliegue en Render

1. Push a GitHub
2. Conectar en Render
3. Configurar variables de entorno
4. Desplegar

## 🔐 Seguridad

- Nunca hagas push del archivo `.env`
- Usa variables de entorno en producción
- Verifica el token de webhook

---

**Creado para Tomcat Store HN** 🕐
