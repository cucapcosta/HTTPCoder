import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { createGuiServer, type GuiServer } from '../src/gui-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

describe('gui-server', () => {
  let gui: GuiServer;
  let received: Array<Record<string, unknown>>;

  beforeAll(async () => {
    received = [];
    gui = await createGuiServer({ port: 0, publicDir });
    gui.on('prompt', (msg) => received.push(msg));
    gui.on('client-connected', (msg) => received.push(msg));
  });

  afterAll(async () => {
    await gui.close();
  });

  it('serve index.html na raiz', async () => {
    const res = await fetch(`http://127.0.0.1:${gui.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="root"');
    expect(html).toContain('/app.js');
  });

  it('aceita conexão WebSocket e recebe eventos JSON da GUI', async () => {
    const ws = new WsClient(`ws://127.0.0.1:${gui.port}`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'prompt', text: 'teste', model: 'm1' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toContainEqual({ type: 'prompt', text: 'teste', model: 'm1' });
    ws.close();
  });

  it('broadcast entrega mensagens aos clientes conectados', async () => {
    const ws = new WsClient(`ws://127.0.0.1:${gui.port}`);
    await once(ws, 'open');
    const incoming = once(ws, 'message');
    gui.broadcast({ type: 'token', id: '1', text: 'abc' });
    const [data] = (await incoming) as [Buffer];
    expect(JSON.parse(data.toString())).toEqual({ type: 'token', id: '1', text: 'abc' });
    ws.close();
  });

  it('novo cliente dispara evento client-connected', async () => {
    const before = received.filter((m) => m.type === 'client-connected').length;
    const ws = new WsClient(`ws://127.0.0.1:${gui.port}`);
    await once(ws, 'open');
    await new Promise((r) => setTimeout(r, 50));
    expect(received.filter((m) => m.type === 'client-connected').length).toBe(before + 1);
    ws.close();
  });
});
