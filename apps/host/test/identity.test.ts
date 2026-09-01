import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveSessionKey,
  generateIdentity,
  type AppMessage,
} from '@httpcoder/protocol';
import { identityPathFor, loadOrCreateIdentity } from '../src/identity.js';
import { HostSession } from '../src/session.js';
import { FakeRelayConsumer, ROOM } from './fake-relay.js';

let dir: string;
let fakes: FakeRelayConsumer[];
let sessions: HostSession[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-identity-'));
  fakes = [];
  sessions = [];
});

afterEach(async () => {
  for (const s of sessions) s.close();
  for (const f of fakes) await f.stop();
  rmSync(dir, { recursive: true, force: true });
});

function configPath(): string {
  return join(dir, 'host.config.json');
}

async function startFake(identity = generateIdentity()): Promise<string> {
  const fake = new FakeRelayConsumer(identity);
  fakes.push(fake);
  return fake.start();
}

function track(session: HostSession): HostSession {
  sessions.push(session);
  return session;
}

describe('loadOrCreateIdentity', () => {
  it('cria o arquivo na 1ª execução e recarrega a MESMA identidade depois', () => {
    const first = loadOrCreateIdentity(configPath());
    const second = loadOrCreateIdentity(configPath());
    expect(second.publicKey.equals(first.publicKey)).toBe(true);

    // a chave privada recarregada deriva o mesmo segredo ECDH
    const peer = generateIdentity();
    const shared1 = deriveSessionKey(first.privateKey, peer.publicKey);
    const shared2 = deriveSessionKey(second.privateKey, peer.publicKey);
    expect(shared2.equals(shared1)).toBe(true);
  });

  it('cria o arquivo com permissão 0600', () => {
    loadOrCreateIdentity(configPath());
    const mode = statSync(identityPathFor(configPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('falha com erro claro se o arquivo estiver corrompido', () => {
    writeFileSync(identityPathFor(configPath()), 'isso não é JSON');
    expect(() => loadOrCreateIdentity(configPath())).toThrow(/identidade/i);
  });

  it('falha com erro claro se faltar campo no arquivo', () => {
    writeFileSync(identityPathFor(configPath()), JSON.stringify({ publicKey: 'AAAA' }));
    expect(() => loadOrCreateIdentity(configPath())).toThrow(/identidade/i);
  });
});

describe('TOFU com identidade persistente', () => {
  it('fingerprint idêntico entre reinícios: pin salvo conecta sem nova confirmação', async () => {
    const url = await startFake();

    // 1ª execução: sem pin, confirma e salva
    let savedPin = '';
    const first = track(
      new HostSession(
        {
          serverUrl: url,
          roomCode: ROOM,
          identity: loadOrCreateIdentity(configPath()),
          confirmFingerprint: async () => true,
          savePin: (pin) => {
            savedPin = pin;
          },
        },
        { onMessage: (_: AppMessage) => {} },
      ),
    );
    const fp1 = await first.connect();
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // "reinício": nova HostSession, identidade recarregada do arquivo
    const second = track(
      new HostSession(
        {
          serverUrl: url,
          roomCode: ROOM,
          identity: loadOrCreateIdentity(configPath()),
          fingerprintPin: savedPin,
          confirmFingerprint: async () => {
            throw new Error('pin válido não deve pedir nova confirmação');
          },
        },
        { onMessage: () => {} },
      ),
    );
    const fp2 = await second.connect();
    expect(fp2).toBe(fp1);
  });

  it('pin diverge (aborta) somente se a outra ponta mudar de identidade', async () => {
    const url = await startFake();
    let savedPin = '';
    const first = track(
      new HostSession(
        {
          serverUrl: url,
          roomCode: ROOM,
          identity: loadOrCreateIdentity(configPath()),
          confirmFingerprint: async () => true,
          savePin: (pin) => {
            savedPin = pin;
          },
        },
        { onMessage: () => {} },
      ),
    );
    await first.connect();
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // consumer "reinstalado": nova identidade na outra ponta
    const url2 = await startFake();
    const second = track(
      new HostSession(
        {
          serverUrl: url2,
          roomCode: ROOM,
          identity: loadOrCreateIdentity(configPath()),
          fingerprintPin: savedPin,
        },
        { onMessage: () => {} },
      ),
    );
    await expect(second.connect()).rejects.toThrow(/FINGERPRINT DIVERGENTE/i);
  });
});
