import * as crypto from 'crypto';

/**
 * Decrypt a Fernet-encrypted doorbell payload from Raspberry Pi
 * Fernet uses AES-128 in CBC mode with HMAC-SHA256 verification
 */
export function decryptDoorbellPayload(
  encryptedBase64: string,
  encryptionKey: Buffer,
): Record<string, any> {
  try {
    // Fernet uses URL-safe base64 (with - and _); base64url decodes both correctly
    let encryptedBytes = Buffer.from(encryptedBase64, 'base64url');

    // Defensive: some senders accidentally base64-encode the Fernet token twice.
    // A correct Fernet token starts with 0x80; if we see 'g' (0x67) it means the
    // decoded bytes are STILL base64 text that needs another decode pass.
    if (encryptedBytes[0] !== 0x80) {
      const innerString = encryptedBytes.toString('utf-8');
      encryptedBytes = Buffer.from(innerString, 'base64url');
    }

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

    // Fernet key spec: first 16 bytes = HMAC signing key, last 16 bytes = AES key
    const signingKey = encryptionKey.slice(0, 16);
    const aesKey = encryptionKey.slice(16, 32);

    // Verify HMAC using the signing key (first half)
    const verifiyData = encryptedBytes.slice(0, hmacStartIndex);
    const computedHmac = crypto
      .createHmac('sha256', signingKey)
      .update(verifiyData)
      .digest();

    if (!crypto.timingSafeEqual(computedHmac, providedHmac)) {
      throw new Error('HMAC verification failed - payload may be tampered');
    }

    // Decrypt using AES-128-CBC with the encryption key (second half)
    const cipher = crypto.createDecipheriv('aes-128-cbc', aesKey, iv);
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
    console.error(
      'Invalid DOORBELL_ENCRYPTION_KEY format (expected base64):',
      errorMessage,
    );
    return null;
  }
}
