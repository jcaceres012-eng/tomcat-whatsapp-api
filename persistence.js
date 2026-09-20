/**
 * persistence.js — Capa de persistencia integrada.
 *
 * Inicializa el almacén PostgreSQL y proporciona una interfaz única
 * para acceder a tokens, números de teléfono y sesiones.
 */

import pg from 'pg';
import { createStore } from './store-postgres.js';

const { Pool } = pg;

let coexistenceStore = null;

/**
 * Inicializa la persistencia. Se llama una sola vez en server.js.
 * FAIL-CLOSED: si la base de datos no conecta, lanza error y app muere.
 */
export async function initPersistence() {
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

  // Crear un Pool de conexiones a PostgreSQL
  const pool = new Pool({
    connectionString: dbUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  // Probar la conexión
  try {
    const testClient = await pool.connect();
    testClient.release();
    console.log('[persistence] Conexión a PostgreSQL exitosa');
  } catch (err) {
    throw new Error(`No se puede conectar a PostgreSQL: ${err.message}`);
  }

  // Crear e inicializar el store PostgreSQL
  coexistenceStore = createStore({ pool, encryptionKey: encKey });
  await coexistenceStore.init();
  
  console.log('[persistence] Base de datos inicializada. keyFingerprint:', coexistenceStore.keyFingerprint);
}

/**
 * Devuelve el store inicializado (después de initPersistence).
 */
export function getStore() {
  if (!coexistenceStore) {
    throw new Error('Persistencia no inicializada (call initPersistence primero)');
  }
  return coexistenceStore;
}
