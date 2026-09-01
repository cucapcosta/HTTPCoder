import { createPrivateKey } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generateIdentity, type Identity } from '@httpcoder/protocol';

/**
 * Identidade X25519 persistente do host, gravada em `<config>.identity.json`
 * com permissão 0600. Estabiliza o fingerprint entre reinícios (TOFU); a chave
 * de sessão (HKDF sobre o ECDH) continua efêmera por conexão.
 */

interface IdentityFile {
  /** SPKI DER em base64. */
  publicKey: string;
  /** PKCS8 DER em base64. */
  privateKey: string;
}

export function identityPathFor(configPath: string): string {
  return `${configPath}.identity.json`;
}

function persist(path: string, identity: Identity): void {
  const data: IdentityFile = {
    publicKey: identity.publicKey.toString('base64'),
    privateKey: Buffer.from(
      identity.privateKey.export({ type: 'pkcs8', format: 'der' }),
    ).toString('base64'),
  };
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  // garante 0600 mesmo se o arquivo já existia com outra permissão
  chmodSync(path, 0o600);
}

function load(path: string): Identity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`não foi possível ler o arquivo de identidade em '${path}': ${reason}`);
  }
  const obj = parsed as Partial<IdentityFile> | null;
  if (
    typeof obj !== 'object' ||
    obj === null ||
    typeof obj.publicKey !== 'string' ||
    typeof obj.privateKey !== 'string'
  ) {
    throw new Error(
      `arquivo de identidade inválido em '${path}': esperado { publicKey, privateKey } em base64`,
    );
  }
  try {
    const publicKey = Buffer.from(obj.publicKey, 'base64');
    const privateKey = createPrivateKey({
      key: Buffer.from(obj.privateKey, 'base64'),
      type: 'pkcs8',
      format: 'der',
    });
    return { publicKey, privateKey };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`arquivo de identidade corrompido em '${path}': ${reason}`);
  }
}

/** Carrega a identidade persistida ou gera e grava uma nova (permissão 0600). */
export function loadOrCreateIdentity(configPath: string): Identity {
  const path = identityPathFor(configPath);
  if (existsSync(path)) return load(path);
  const identity = generateIdentity();
  persist(path, identity);
  return identity;
}
