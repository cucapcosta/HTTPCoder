import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { generateIdentity, type Identity } from '@httpcoder/protocol';

/** Caminho do arquivo de identidade persistida: sempre ao lado do config. */
export function identityPathFor(configPath: string): string {
  return `${configPath}.identity.json`;
}

interface IdentityFile {
  privateKey: string; // PKCS8 DER base64
  publicKey: string; // SPKI DER base64
}

function persist(file: string, identity: Identity): void {
  const data: IdentityFile = {
    privateKey: identity.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: identity.publicKey.toString('base64'),
  };
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Carrega a identidade X25519 persistida em `<configPath>.identity.json`,
 * gerando e persistindo um novo par na primeira execução.
 *
 * Arquivo ausente, corrompido ou com par inconsistente (pública que não deriva
 * da privada) → gera identidade nova e sobrescreve. Nesse caso o fingerprint
 * muda e um fingerprintPin existente divergirá legitimamente (TOFU avisa).
 *
 * Só a identidade é persistida; a chave de sessão (HKDF sobre o ECDH)
 * continua efêmera por conexão — forward secrecy mantido.
 */
export function loadOrCreateIdentity(configPath: string): Identity {
  const file = identityPathFor(configPath);
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as IdentityFile;
    if (typeof raw.privateKey !== 'string' || typeof raw.publicKey !== 'string') {
      throw new Error('campos ausentes');
    }
    const privateKey = createPrivateKey({ key: Buffer.from(raw.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    const publicKey = Buffer.from(raw.publicKey, 'base64');
    // confere que a pública persistida corresponde à privada
    const derived = Buffer.from(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }));
    if (!derived.equals(publicKey)) throw new Error('par inconsistente');
    return { publicKey, privateKey };
  } catch {
    const identity = generateIdentity();
    persist(file, identity);
    return identity;
  }
}
