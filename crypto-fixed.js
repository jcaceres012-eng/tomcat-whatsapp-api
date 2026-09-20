/**
 * crypto-fixed.js — Capa de criptografía segura para tokens.
 *
 * Reemplaza crypto.createCipher() (deprecated) con createCipheriv() (secure).
 * Cada operación usa un IV aleatorio, formato v2.
 *
 * Uso:
 *   const cm = createCryptoModule(encryptionKey);
 *   const encrypted = cm.encryptToken(plaintextToken);
 *   const decrypted = cm.decryptToken(encrypted);
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const KEY_SIZE = 32;  // 256 bits for aes-256
const IV_SIZE = 16;   // 128 bits

function createCryptoModule(encryptionKeyHex) {
  if (!encryptionKeyHex) {
    throw new Error('encryptionKey es requerido para crypto-fixed.js');
  }

  let key;
  try {
    // Si es hex (64 chars), usarlo directamente; si no, derivar
    if (typeof encryptionKeyHex === 'string' && encryptionKeyHex.length === 64) {
      key = Buffer.from(encryptionKeyHex, 'hex');
    } else if (typeof encryptionKeyHex === 'string') {
      // Derivar una clave de 32 bytes usando SHA-256
      key = crypto.createHash('sha256').update(encryptionKeyHex).digest();
    } else {
      throw new Error('encryptionKey debe ser string hexadecimal o texto');
    }

    if (key.length !== KEY_SIZE) {
      throw new Error(`Clave debe ser exactamente ${KEY_SIZE} bytes (${KEY_SIZE * 2} hex chars)`);
    }
  } catch (e) {
    throw new Error(`Clave de encriptación inválida: ${e.message}`);
  }

  // Fingerprint: primeros 16 chars de hash de la clave (para detectar rotación)
  const keyFingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);

  function encryptToken(plaintext) {
    if (typeof plaintext !== 'string') {
      throw new Error('Token debe ser string');
    }
    const iv = crypto.randomBytes(IV_SIZE);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    // Formato: v2:<iv>:<ciphertext>
    return `v2:${iv.toString('hex')}:${encrypted}`;
  }

  function decryptToken(ciphertextWithIv) {
    if (!ciphertextWithIv || typeof ciphertextWithIv !== 'string') {
      throw new Error('Ciphertext inválido');
    }

    const parts = ciphertextWithIv.split(':');
    if (parts.length !== 3 || parts[0] !== 'v2') {
      throw new Error('Formato de ciphertext inválido (esperado v2:iv:ciphertext)');
    }

    const ivHex = parts[1];
    const encryptedHex = parts[2];

    if (ivHex.length !== IV_SIZE * 2 || encryptedHex.length === 0) {
      throw new Error('IV o ciphertext malformado');
    }

    try {
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (e) {
      throw new Error(`Desencriptación fallida: ${e.message}`);
    }
  }

  return {
    encryptToken,
    decryptToken,
    keyFingerprint,
    algorithm: ALGORITHM,
    keySize: KEY_SIZE
  };
}

module.exports = { createCryptoModule };
