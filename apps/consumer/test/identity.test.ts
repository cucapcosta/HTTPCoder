import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import { deriveSessionKey, generateIdentity, hashRoom, serialize } from '@httpcoder/protocol';
import { identityPathFor, loadOrCreateIdentity } from '../src/identity.js';
import { Session } from '../src/session.js';

const ROOM_CODE = 'sala-identidade-123';

let dir: string | undefined;
let configPath: string;

async function freshConfigDir(): Promise<void> {
  dir = await mkdtemp(path.join(tmpdir(), 'consumer-identity-'));
  configPath = path.join(dir, 'consumer.config.json');
  await writeFile(configPath, JSON.stringify({ serverUrl: 'ws://x', roomCode: ROOM_CODE, allowedPaths: [], allowedCommands: [] }));
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('identidade persistente (arquivo)', () => {
  it('primeira execução gera e persiste; segunda carrega a mesma identidade', async () => {
    await freshConfigDir();
    const first = loadOrCreateIdentity(configPath);
    const second = loadOrCreateIdentity(configPath);
    expect(second.publicKey.equals(first.publicKey)).toBe(true);
  });

  it('arquivo é criado com permissão 0600', async () => {
    await freshConfigDir();
    loadOrCreateIdentity(configPath);
    const info = await stat(identityPathFor(configPath));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('arquivo corrompido gera identidade nova sem quebrar', async () => {
    await freshConfigDir();
    const first = loadOrCreateIdentity(configPath);
    await writeFile(identityPathFor(configPath), 'isso nao eh json {', 'utf8');
    const second = loadOrCreateIdentity(configPath);
    expect(second.publicKey.equals(first.publicKey)).toBe(false);
    // e o novo par foi persistido corretamente
    const third = loadOrCreateIdentity(configPath);
    expect(third.publicKey.equals(second.publicKey)).toBe(true);
  });

  it('arquivo com par inconsistente (pública ≠ privada) é descartado', async () => {
    await freshConfigDir();
    const a = generateIdentity();
    const b = generateIdentity();
    await writeFile(
      identityPathFor(configPath),
      JSON.stringify({
        privateKey: a.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
        publicKey: b.publicKey.toString('base64'),
      }),
      'utf8',
    );
    const loaded = loadOrCreateIdentity(configPath);
    expect(loaded.publicKey.equals(b.publicKey)).toBe(false);
    // o arquivo reescrito é íntegro: pública deriva da privada persistida
    const raw = JSON.parse(await readFile(identityPathFor(configPath), 'utf8')) as { publicKey: string };
    expect(Buffer.from(raw.publicKey, 'base64').equals(loaded.publicKey)).toBe(true);
  });
});

describe('identidade persistente na Session (fingerprint estável entre reinícios)', () => {
  it('duas sessões com o mesmo config têm o mesmo fingerprint com o mesmo host', async () => {
    await freshConfigDir();

    // relay + host fake com identidade fixa
    const hostId = generateIdentity();
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.on('listening', r));
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
    wss.on('connection', (ws: WsClient) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { type: string; publicKey?: string };
        if (msg.type === 'handshake') {
          // host: deriva a chave (só para validar o ECDH) e responde com sua pública fixa
          deriveSessionKey(hostId.privateKey, Buffer.from(msg.publicKey!, 'base64'));
          ws.send(serialize({ type: 'handshake', role: 'host', publicKey: hostId.publicKey.toString('base64') }));
        }
      });
    });

    const fingerprints: string[] = [];
    const publicKeys: Buffer[] = [];
    for (let i = 0; i < 2; i++) {
      // cada iteração simula um "reinício" do consumer com o mesmo config
      const identity = loadOrCreateIdentity(configPath);
      const session = new Session({ serverUrl: url, roomCode: ROOM_CODE, reconnect: false, identity });
      session.connect();
      const [{ fingerprint }] = (await once(session, 'ready')) as [{ fingerprint: string }];
      fingerprints.push(fingerprint);
      publicKeys.push(session.publicKey);
      session.close();
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(publicKeys[1]!.equals(publicKeys[0]!)).toBe(true);
    expect(fingerprints[1]).toBe(fingerprints[0]);

    await new Promise((r) => wss.close(r));
  }, 15000);
});
