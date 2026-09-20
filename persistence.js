/**
 * persistence.js — Capa de persistencia integrada.
 *
 * Inicializa el almacén PostgreSQL y proporciona una interfaz única
 * para acceder a tokens, números de teléfono y sesiones.
 */

const { createStore } = require('./store-postgres');

let coexistenceStore = null;

/**
 * Inicializa la persistencia. Se llama una sola vez en server.js.
 * FAIL-CLOSED: si la base de datos no conecta, lanza error y app muere.
 */
async function initPersistence() {
  if (coexistenceStore) {
    return; // ya inicializada
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL requerida');
  }

  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) {
    throw new Error('ENCRYPTION_KEY requerida');
  }

  // Crear e inicializar el store PostgreSQL
  coexistenceStore = createStore(dbUrl, encKey);
  await coexistenceStore.init();
  
  console.log('[persistence] Base de datos inicializada. keyFingerprint:', coexistenceStore.keyFingerprint);
}

/**
 * Devuelve el store inicializado (después de initPersistence).
 */
function getStore() {
  if (!coexistenceStore) {
    throw new Error('Persistencia no inicializada (call initPersistence primero)');
  }
  return coexistenceStore;
}

module.exports = {
  initPersistence,
  getStore,
};
