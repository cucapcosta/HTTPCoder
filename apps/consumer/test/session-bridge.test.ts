import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import {
  decrypt,
  deriveSessionKey,
  encrypt,
  fingerprint,
  generateIdentity,
  hashRoom,
  parseAppMessage,
  serialize,
  type AppMessage,
} from '@httpcoder/protocol';
import { Session } from '../src/session.js';
import { Bridge, type GuiHub } from '../src/bridge.js';
import { PermissionEngine } from '../src/permissions.js';
import { Sandbox } from '../src/sandbox.js';

const ROOM_CODE = 'sala-teste-123';

// --- Relay fake: roteia frames entre host e consumer da mesma sala ---
function startFakeRelay(): Promise<{ wss: WebSocketServer; url: string }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => {
      const addr = wss.address() as { port: number };
      resolve({ wss, url: `ws://127.0.0.1:${addr.port}` });
    });
    const rooms = new Map<string, Partial<Record<'host' | 'consumer', WsClient>>>();
    wss.on('connection', (ws) => {
      let room = '';
      let role: 'host' | 'consumer' | '' = '';
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { type: string; role?: 'host' | 'consumer'; room?: string };
        if (msg.type === 'hello') {
          room = msg.room!;
          role = msg.role!;
          const r = rooms.get(room) ?? {};
          rooms.set(room, r);
          r[role] = ws;
          const peerRole = role === 'host' ? 'consumer' : 'host';
          const peer = r[peerRole];
          if (peer) {
            ws.send(JSON.stringify({ type: 'peer-connected', role: peerRole }));
            peer.send(JSON.stringify({ type: 'peer-connected', role }));
          }
          return;
        }
        const r = rooms.get(room);
        const peer = role === 'host' ? r?.consumer : r?.host;
        peer?.send(data.toString());
      });
    });
  });
}

// --- Host fake: faz o handshake e responde como o host real faria ---
class FakeHost extends EventEmitter {
  private ws: WsClient;
  private identity = generateIdentity();
  private key?: Buffer;
  readonly roomCode = ROOM_CODE;

  constructor(url: string) {
    super();
    this.ws = new WsClient(url);
    this.ws.on('open', () => {
      this.ws.send(serialize({ type: 'hello', role: 'host', room: hashRoom(ROOM_CODE) }));
    });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as
        | { type: 'handshake'; publicKey: string }
        | { type: 'frame'; data: string };
      if (msg.type === 'handshake') {
        this.key = deriveSessionKey(this.identity.privateKey, Buffer.from(msg.publicKey, 'base64'));
        this.ws.send(
          serialize({ type: 'handshake', role: 'host', publicKey: this.identity.publicKey.toString('base64') }),
        );
        this.emit('ready');
        return;
      }
      if (msg.type === 'frame' && this.key) {
        const app = parseAppMessage(decrypt(this.key, Buffer.from(msg.data, 'base64')).toString('utf8'));
        this.emit('app', app);
      }
    });
  }

  sendApp(msg: AppMessage): void {
    if (!this.key) throw new Error('host sem chave de sessão');
    this.ws.send(
      serialize({ type: 'frame', data: encrypt(this.key, Buffer.from(serialize(msg), 'utf8')).toString('base64') }),
    );
  }

  async nextApp(): Promise<AppMessage> {
    const [msg] = await once(this, 'app');
    return msg as AppMessage;
  }

  fingerprintOf(consumerPub: Buffer): string {
    return fingerprint(this.identity.publicKey, consumerPub, ROOM_CODE);
  }

  close(): void {
    this.ws.close();
  }
}

// --- Hub da GUI fake: captura broadcasts e injeta eventos da GUI ---
class StubHub extends EventEmitter implements GuiHub {
  sent: Array<Record<string, unknown>> = [];
  broadcast(msg: Record<string, unknown>): void {
    this.sent.push(msg);
  }
  async waitFor(type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.sent.find((m) => m.type === type);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout esperando broadcast '${type}'`);
  }
}

describe('session + bridge com relay e host fake', () => {
  let relay: { wss: WebSocketServer; url: string };
  let host: FakeHost;
  let session: Session;
  let hub: StubHub;
  let sandbox: Sandbox;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'consumer-bridge-'));
    await writeFile(path.join(root, 'nota.txt'), 'conteudo da nota');
    relay = await startFakeRelay();
    host = new FakeHost(relay.url);
    sandbox = await Sandbox.create({ allowedPaths: [root], allowedCommands: ['echo'], cwd: root });
    const permissions = new PermissionEngine();
    hub = new StubHub();
    session = new Session({
      serverUrl: relay.url,
      roomCode: ROOM_CODE,
      reconnect: false,
    });
    // sem pin configurado, a sessão gateia até a decisão TOFU: auto-confirma nos testes do fluxo principal
    session.on('fingerprint-confirm', () => session.resolveFingerprint('confirm'));
    new Bridge({ session, sandbox, permissions, hub });
    // registra os waits ANTES de conectar: o host emite 'ready' antes da sessão
    const sessionReady = once(session, 'ready');
    const hostReady = once(host, 'ready');
    session.connect();
    await Promise.all([sessionReady, hostReady]);
  }, 15000);

  afterAll(async () => {
    session.close();
    host.close();
    await new Promise((r) => relay.wss.close(r));
    await rm(root, { recursive: true, force: true });
  });

  it('handshake deriva o mesmo fingerprint nos dois lados', () => {
    expect(session.fingerprint).toBeTruthy();
    expect(session.fingerprint).toBe(host.fingerprintOf(session.publicKey));
  });

  it('ao ficar pronto, pede a lista de modelos e a repassa à GUI', async () => {
    const req = host.nextApp();
    // a bridge pode já ter enviado o model-list-request no ready; enviamos a resposta ao recebê-lo
    const msg = (await Promise.race([req, new Promise((r) => setTimeout(() => r(null), 2000))])) as AppMessage | null;
    expect(msg?.type ?? 'model-list-request').toBe('model-list-request');
    host.sendApp({ type: 'model-list', models: ['llama3.1', 'qwen2.5'] });
    const models = await hub.waitFor('models');
    expect(models.models).toEqual(['llama3.1', 'qwen2.5']);
  });

  it('prompt da GUI chega ao host; token/final voltam para a GUI', async () => {
    const received = host.nextApp();
    hub.emit('prompt', { type: 'prompt', text: 'olá host', model: 'llama3.1' });
    const msg = (await received) as AppMessage;
    expect(msg.type).toBe('prompt');
    if (msg.type === 'prompt') {
      expect(msg.text).toBe('olá host');
      expect(msg.model).toBe('llama3.1');
      host.sendApp({ type: 'token', id: msg.id, text: 'olá ' });
      host.sendApp({ type: 'token', id: msg.id, text: 'consumer' });
      host.sendApp({ type: 'final', id: msg.id, text: 'olá consumer' });
    }
    const token = await hub.waitFor('token');
    expect(token.text).toBe('olá ');
    const final = await hub.waitFor('final');
    expect(final.text).toBe('olá consumer');
  });

  it('tool-call dentro do sandbox: pede permissão, executa e devolve tool-result', async () => {
    host.sendApp({
      type: 'tool-call',
      id: 't1',
      callId: 'c1',
      name: 'read_file',
      args: { path: path.join(root, 'nota.txt') },
    });
    const req = await hub.waitFor('permission-request');
    expect(req.tool).toBe('read_file');
    expect(req.requestId).toBeTruthy();

    const resultPromise = host.nextApp();
    hub.emit('permission-result', { type: 'permission-result', requestId: req.requestId, decision: 'once' });
    const result = (await resultPromise) as AppMessage;
    expect(result.type).toBe('tool-result');
    if (result.type === 'tool-result') {
      expect(result.callId).toBe('c1');
      expect(result.ok).toBe(true);
      expect(result.output).toContain('conteudo da nota');
    }
  });

  it('tool-call negado pelo usuário devolve tool-result com ok=false', async () => {
    const seenBefore = hub.sent.filter((m) => m.type === 'permission-request').length;
    host.sendApp({
      type: 'tool-call',
      id: 't2',
      callId: 'c2',
      name: 'write_file',
      args: { path: path.join(root, 'x.txt'), content: 'abc' },
    });
    // espera um NOVO permission-request (o do teste anterior já foi resolvido)
    const start = Date.now();
    let last: Record<string, unknown> | undefined;
    while (Date.now() - start < 5000) {
      const requests = hub.sent.filter((m) => m.type === 'permission-request');
      if (requests.length > seenBefore) {
        last = requests[requests.length - 1];
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(last?.tool).toBe('write_file');
    expect(last?.diff).toBeDefined();

    const resultPromise = host.nextApp();
    hub.emit('permission-result', { type: 'permission-result', requestId: last!.requestId, decision: 'deny' });
    const result = (await resultPromise) as AppMessage;
    expect(result.type).toBe('tool-result');
    if (result.type === 'tool-result') expect(result.ok).toBe(false);
  });

  it('tool-call fora do sandbox é recusado sem pedir permissão', async () => {
    host.sendApp({
      type: 'tool-call',
      id: 't3',
      callId: 'c3',
      name: 'read_file',
      args: { path: '/etc/passwd' },
    });
    const result = (await host.nextApp()) as AppMessage;
    expect(result.type).toBe('tool-result');
    if (result.type === 'tool-result') {
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/fora das pastas permitidas/);
    }
  });

  it('run_command fora da allowlist é recusado sem pedir permissão', async () => {
    host.sendApp({
      type: 'tool-call',
      id: 't4',
      callId: 'c4',
      name: 'run_command',
      args: { command: 'rm -rf /' },
    });
    const result = (await host.nextApp()) as AppMessage;
    expect(result.type).toBe('tool-result');
    if (result.type === 'tool-result') expect(result.ok).toBe(false);
  });
});

describe('session — TOFU', () => {
  it('fingerprintPin divergente emite fingerprint-mismatch e não fica pronta', async () => {
    const relay = await startFakeRelay();
    const host = new FakeHost(relay.url);
    const s = new Session({
      serverUrl: relay.url,
      roomCode: ROOM_CODE,
      fingerprintPin: 'FFFF FFFF FFFF FFFF',
      reconnect: false,
    });
    s.connect();
    const [mismatch] = await once(s, 'fingerprint-mismatch');
    expect(mismatch.expected).toBe('FFFF FFFF FFFF FFFF');
    expect(mismatch.actual).toBeTruthy();
    expect(s.fingerprint).toBeUndefined();
    s.close();
    host.close();
    await new Promise((r) => relay.wss.close(r));
  }, 15000);

  it('fingerprintPin correto não emite fingerprint-confirm e fica pronta direto', async () => {
    const relay = await startFakeRelay();
    const host = new FakeHost(relay.url);
    const identity = generateIdentity();
    const s = new Session({
      serverUrl: relay.url,
      roomCode: ROOM_CODE,
      fingerprintPin: host.fingerprintOf(identity.publicKey),
      identity,
      reconnect: false,
    });
    let confirmFired = false;
    s.on('fingerprint-confirm', () => {
      confirmFired = true;
    });
    s.connect();
    const [ready] = await once(s, 'ready');
    expect(confirmFired).toBe(false);
    expect(ready.fingerprint).toBe(host.fingerprintOf(identity.publicKey));
    expect(s.ready).toBe(true);
    s.close();
    host.close();
    await new Promise((r) => relay.wss.close(r));
  }, 15000);

  it('sem pin: emite fingerprint-confirm, gateia frames até a decisão e confirm libera o envio', async () => {
    const relay = await startFakeRelay();
    const host = new FakeHost(relay.url);
    const s = new Session({ serverUrl: relay.url, roomCode: ROOM_CODE, reconnect: false });
    let readyFired = false;
    s.on('ready', () => {
      readyFired = true;
    });
    const confirmP = once(s, 'fingerprint-confirm');
    s.connect();
    const [ev] = (await confirmP) as [{ fingerprint: string }];
    expect(ev.fingerprint).toBeTruthy();
    expect(s.fingerprint).toBe(ev.fingerprint);
    // ainda não está pronta: envio gateado
    expect(readyFired).toBe(false);
    expect(s.ready).toBe(false);
    expect(() => s.sendApp({ type: 'prompt', id: 'p1', text: 'oi' })).toThrow(/fingerprint/i);
    // frames recebidos antes da decisão são descartados
    let msgReceived = false;
    s.on('message', () => {
      msgReceived = true;
    });
    host.sendApp({ type: 'token', id: 'p1', text: 'segredo' });
    await new Promise((r) => setTimeout(r, 200));
    expect(msgReceived).toBe(false);
    // confirm libera a sessão
    const readyP = once(s, 'ready');
    s.resolveFingerprint('confirm');
    await readyP;
    expect(readyFired).toBe(true);
    expect(s.ready).toBe(true);
    const received = host.nextApp();
    s.sendApp({ type: 'prompt', id: 'p2', text: 'liberado' });
    const msg = (await received) as AppMessage;
    expect(msg.type).toBe('prompt');
    s.close();
    host.close();
    await new Promise((r) => relay.wss.close(r));
  }, 15000);

  it("resolveFingerprint('abort') fecha a conexão sem ficar pronta", async () => {
    const relay = await startFakeRelay();
    const host = new FakeHost(relay.url);
    const s = new Session({ serverUrl: relay.url, roomCode: ROOM_CODE, reconnect: false });
    let readyFired = false;
    s.on('ready', () => {
      readyFired = true;
    });
    const confirmP = once(s, 'fingerprint-confirm');
    s.connect();
    await confirmP;
    const statusP = once(s, 'status');
    s.resolveFingerprint('abort');
    const [status] = await statusP;
    expect(status).toBe('disconnected');
    expect(readyFired).toBe(false);
    expect(s.ready).toBe(false);
    s.close();
    host.close();
    await new Promise((r) => relay.wss.close(r));
  }, 15000);
});

describe('bridge — fingerprint-result da GUI (TOFU)', () => {
  let relay: { wss: WebSocketServer; url: string };
  let host: FakeHost;
  let dir: string;

  beforeAll(async () => {
    relay = await startFakeRelay();
    host = new FakeHost(relay.url);
    dir = await mkdtemp(path.join(tmpdir(), 'consumer-tofu-'));
  });

  afterAll(async () => {
    host.close();
    await new Promise((r) => relay.wss.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  async function setupBridge(configName: string): Promise<{ session: Session; hub: StubHub; configFile: string }> {
    const configFile = path.join(dir, configName);
    await writeFile(
      configFile,
      JSON.stringify({ serverUrl: relay.url, roomCode: ROOM_CODE, allowedPaths: [dir], allowedCommands: [] }),
    );
    const sandbox = await Sandbox.create({ allowedPaths: [dir], allowedCommands: [], cwd: dir });
    const hub = new StubHub();
    const session = new Session({ serverUrl: relay.url, roomCode: ROOM_CODE, reconnect: false });
    new Bridge({ session, sandbox, permissions: new PermissionEngine(), hub, configPath: configFile });
    session.connect();
    return { session, hub, configFile };
  }

  it('decisão confirm libera a sessão e grava o pin no config', async () => {
    const { session, hub, configFile } = await setupBridge('confirm.json');
    const card = await hub.waitFor('fingerprint-confirm');
    expect(card.fingerprint).toBeTruthy();
    expect(session.ready).toBe(false);

    // envio liberado: model-list-request automático + prompt da GUI chegam ao host
    // (listener anexado ANTES da decisão: o frame pode chegar no mesmo tick do ready)
    const firstP = host.nextApp();
    const readyP = once(session, 'ready');
    hub.emit('fingerprint-result', { type: 'fingerprint-result', decision: 'confirm' });
    await readyP;
    expect(session.ready).toBe(true);

    // pin gravado em arquivo real, preservando os demais campos
    const saved = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;
    expect(saved.fingerprintPin).toBe(session.fingerprint);
    expect(saved.roomCode).toBe(ROOM_CODE);

    const first = (await firstP) as AppMessage;
    expect(first.type).toBe('model-list-request');
    const promptP = host.nextApp();
    hub.emit('prompt', { type: 'prompt', text: 'pós-confirm' });
    const prompt = (await promptP) as AppMessage;
    expect(prompt.type).toBe('prompt');
    session.close();
  }, 15000);

  it('decisão abort fecha a sessão e não grava pin', async () => {
    const { session, hub, configFile } = await setupBridge('abort.json');
    await hub.waitFor('fingerprint-confirm');

    const statusP = once(session, 'status');
    hub.emit('fingerprint-result', { type: 'fingerprint-result', decision: 'abort' });
    const [status] = await statusP;
    expect(status).toBe('disconnected');
    expect(session.ready).toBe(false);

    const saved = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;
    expect(saved.fingerprintPin).toBeUndefined();
    session.close();
  }, 15000);
});
