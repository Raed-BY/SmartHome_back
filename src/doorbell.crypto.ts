import * as crypto from 'crypto';
import * as base64 from 'base64-js';

/**
 * Decrypt a Fernet-encrypted doorbell payload from Raspberry Pi
 * Fernet uses AES-128 in CBC mode with HMAC-SHA256 verification
 */
export function decryptDoorbellPayload(encryptedBase64: string, encryptionKey: Buffer): Record<string, any> {
  try {
    // Decode base64 string
    const encryptedBytes = Buffer.from(encryptedBase64, 'base64');

    // Fernet format: [version (1 byte)][timestamp (8 bytes)][iv (16 bytes)][ciphertext][hmac (32 bytes)]
    if (encryptedBytes.length < 57) {
      throw new Error('Encrypted payload too short');
    }

    const version = encryptedBytes[0];
    if (version !== 0x80) {
      throw new Error(`Invalid Fernet version: ${version}`);
    }

    const timestamp = encryptedBytes.slice(1, 9);
    const iv = encryptedBytes.slice(9, 25);
    const hmacStartIndex = encryptedBytes.length - 32;
    const ciphertext = encryptedBytes.slice(25, hmacStartIndex);
    const providedHmac = encryptedBytes.slice(hmacStartIndex);

    // Verify HMAC
    const verifiyData = encryptedBytes.slice(0, hmacStartIndex);
    const computedHmac = crypto.createHmac('sha256', encryptionKey).update(verifiyData).digest();

    if (!crypto.timingSafeEqual(computedHmac, providedHmac)) {
      throw new Error('HMAC verification failed - payload may be tampered');
    }

    // Decrypt using AES-128-CBC
    const cipher = crypto.createDecipheriv('aes-128-cbc', encryptionKey.slice(0, 16), iv);
    let decrypted = cipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, cipher.final()]);

    // Parse JSON
    const plaintext = decrypted.toString('utf-8');
    return JSON.parse(plaintext);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Doorbell decryption failed:', errorMessage);
    throw new Error(`Failed to decrypt doorbell payload: ${errorMessage}`);
  }
}

/**
 * Get encryption key from environment variable (base64-encoded)
 */
export function getEncryptionKeyFromEnv(): Buffer | null {
  const keyEnv = process.env.DOORBELL_ENCRYPTION_KEY;
  if (!keyEnv) {
    return null; // Decryption will be skipped if no key configured
  }

  try {
    return Buffer.from(keyEnv, 'base64');
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Invalid DOORBELL_ENCRYPTION_KEY format (expected base64):', errorMessage);
    return null;
  }
}
