import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

export interface Identity {
  /** Chave pública X25519 em DER/SPKI, pronta para enviar no handshake. */
  publicKey: Buffer;
  privateKey: KeyObject;
}

export function generateIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })),
    privateKey,
  };
}

function importPublic(der: Buffer): KeyObject {
  return createPublicKey({ key: der, type: 'spki', format: 'der' });
}

/** Deriva a chave de sessão AES-256 compartilhada (HKDF-SHA256 sobre o segredo X25519). */
export function deriveSessionKey(privateKey: KeyObject, peerPublicKey: Buffer): Buffer {
  const shared = diffieHellman({ privateKey, publicKey: importPublic(peerPublicKey) });
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('httpcoder-session'), 32));
}

/** Retorna nonce(12) ‖ ciphertext ‖ tag(16). */
export function encrypt(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

/** Inverte {@link encrypt}; lança erro se a tag GCM não conferir. */
export function decrypt(key: Buffer, frame: Buffer): Buffer {
  if (frame.length < 12 + 16 + 1) throw new Error('frame curto demais');
  const nonce = frame.subarray(0, 12);
  const tag = frame.subarray(frame.length - 16);
  const ct = frame.subarray(12, frame.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Hash SHA-256 do código da sala — é o que o servidor vê, nunca o código em si. */
export function hashRoom(roomCode: string): string {
  return createHash('sha256').update(roomCode, 'utf8').digest('hex');
}

/**
 * Fingerprint anti-MITM exibido nos dois lados (TOFU).
 * Independe de qual lado é host/consumer (chaves ordenadas antes do hash).
 */
export function fingerprint(pubA: Buffer, pubB: Buffer, roomCode: string): string {
  const [first, second] = [pubA.toString('hex'), pubB.toString('hex')].sort();
  const hash = createHash('sha256');
  hash.update(first!, 'utf8');
  hash.update(second!, 'utf8');
  hash.update(roomCode, 'utf8');
  return hash
    .digest('hex')
    .slice(0, 16)
    .toUpperCase()
    .replace(/(.{4})/g, '$1 ')
    .trim();
}
