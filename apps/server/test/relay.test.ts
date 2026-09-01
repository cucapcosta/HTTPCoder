import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { serialize, type RelayMessage, type Role } from '@httpcoder/protocol';
import { createRelayServer, type RelayServer } from '../src/relay.js';

const ROOM = 'hash-da-sala';

let relay: RelayServer;
let baseUrl: string;

// Caixa de entrada por socket: evita perder mensagens que chegam
// antes de o teste registrar o listener (race entre connect e nextMessage).
interface Inbox {
  messages: string[];
  resolve?: (raw: string) => void;
}
const inboxes = new Map<WebSocket, Inbox>();

function setupInbox(ws: WebSocket): void {
  const inbox: Inbox = { messages: [] };
  ws.on('message', (data) => {
    const raw = data.toString();
    if (inbox.resolve) {
      const resolve = inbox.resolve;
      inbox.resolve = undefined;
      resolve(raw);
    } else {
      inbox.messages.push(raw);
    }
  });
  inboxes.set(ws, inbox);
}

function nextRaw(ws: WebSocket): Promise<string> {
  const inbox = inboxes.get(ws);
  if (!inbox) throw new Error('socket sem inbox');
  const pending = inbox.messages.shift();
  if (pending !== undefined) return Promise.resolve(pending);
  return new Promise((resolve) => {
    inbox.resolve = resolve;
  });
}

async function nextMessage(ws: WebSocket): Promise<RelayMessage> {
  return JSON.parse(await nextRaw(ws)) as RelayMessage;
}

async function connect(role: Role, room = ROOM): Promise<WebSocket> {
  const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
  setupInbox(ws);
  await once(ws, 'open');
  ws.send(serialize({ type: 'hello', role, room }));
  return ws;
}

beforeEach(async () => {
  relay = createRelayServer({ port: 0 });
  await once(relay.server, 'listening');
  baseUrl = `http://127.0.0.1:${relay.port()}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await relay.close();
  inboxes.clear();
});

describe('rotas HTTP', () => {
  it('GET /health responde 200 ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('GET /download/host redireciona 302 para HOST_ASSET_URL', async () => {
    vi.stubEnv('HOST_ASSET_URL', 'https://example.com/host.exe');
    const res = await fetch(`${baseUrl}/download/host`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/host.exe');
  });

  it('GET /download/consumer redireciona 302 para CONSUMER_ASSET_URL', async () => {
    vi.stubEnv('CONSUMER_ASSET_URL', 'https://example.com/consumer.exe');
    const res = await fetch(`${baseUrl}/download/consumer`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/consumer.exe');
  });

  it('GET /download/host sem HOST_ASSET_URL responde 503', async () => {
    vi.stubEnv('HOST_ASSET_URL', '');
    const res = await fetch(`${baseUrl}/download/host`, { redirect: 'manual' });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('HOST_ASSET_URL');
  });

  it('GET /download/consumer sem CONSUMER_ASSET_URL responde 503', async () => {
    vi.stubEnv('CONSUMER_ASSET_URL', '');
    const res = await fetch(`${baseUrl}/download/consumer`, { redirect: 'manual' });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('CONSUMER_ASSET_URL');
  });
});

describe('relay WebSocket', () => {
  it('retransmite handshake e frame verbatim entre host e consumer', async () => {
    const host = await connect('host');
    const consumer = await connect('consumer');

    // host é avisado quando o consumer entra na sala
    expect(await nextMessage(host)).toEqual({ type: 'peer-connected', role: 'consumer' });

    const handshake = serialize({ type: 'handshake', role: 'consumer', publicKey: 'cHViLWNvbnN1bWVy' });
    consumer.send(handshake);
    expect(await nextRaw(host)).toBe(handshake);

    const frame = serialize({ type: 'frame', data: 'Y2lwaGVyLXRleHQ=' });
    host.send(frame);
    expect(await nextRaw(consumer)).toBe(frame);
  });

  it('rejeita um segundo host na mesma sala', async () => {
    const host1 = await connect('host');
    const host2 = await connect('host');

    const msg = await nextMessage(host2);
    expect(msg.type).toBe('error');
    await once(host2, 'close');
    expect(host2.readyState).toBe(WebSocket.CLOSED);

    // o host original continua intacto
    const consumer = await connect('consumer');
    expect(await nextMessage(host1)).toEqual({ type: 'peer-connected', role: 'consumer' });
  });

  it('rejeita um segundo consumer na mesma sala', async () => {
    await connect('consumer');
    const consumer2 = await connect('consumer');

    const msg = await nextMessage(consumer2);
    expect(msg.type).toBe('error');
    await once(consumer2, 'close');
    expect(consumer2.readyState).toBe(WebSocket.CLOSED);
  });

  it('notifica peer-disconnected quando o par desconecta', async () => {
    const host = await connect('host');
    const consumer = await connect('consumer');
    await nextMessage(host); // peer-connected

    consumer.close();
    expect(await nextMessage(host)).toEqual({ type: 'peer-disconnected', role: 'consumer' });
  });

  it('libera o slot ao desconectar e aceita um novo host na sala', async () => {
    const host1 = await connect('host');
    host1.close();
    await once(host1, 'close');
    // pequena folga para o servidor processar o close antes do novo hello
    await new Promise((resolve) => setTimeout(resolve, 50));

    const host2 = await connect('host');
    const consumer = await connect('consumer');
    expect(await nextMessage(host2)).toEqual({ type: 'peer-connected', role: 'consumer' });
  });

  it('descarta frame quando o par ainda não conectou', async () => {
    const host = await connect('host');
    host.send(serialize({ type: 'frame', data: 'c2VtLXBhcg==' }));

    // consumer entra depois; o host existente é quem é avisado da chegada do par
    const consumer = await connect('consumer');
    expect(await nextMessage(host)).toEqual({ type: 'peer-connected', role: 'consumer' });

    // o frame enviado sem par foi descartado: a primeira mensagem que o
    // consumer recebe é o handshake novo, não o frame antigo
    const handshake = serialize({ type: 'handshake', role: 'host', publicKey: 'cHViLWhvc3Q=' });
    host.send(handshake);
    expect(await nextRaw(consumer)).toBe(handshake);
  });
});
