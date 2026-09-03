import { EventEmitter, once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRelayServer, type RelayServer } from '../apps/server/src/relay.js';
import { HostSession } from '../apps/host/src/session.js';
import { AgentLoop } from '../apps/host/src/agent.js';
import { OllamaClient } from '../apps/host/src/ollama.js';
import { Session } from '../apps/consumer/src/session.js';
import { Bridge, type GuiHub, type GuiMessage } from '../apps/consumer/src/bridge.js';
import { PermissionEngine } from '../apps/consumer/src/permissions.js';
import { Sandbox } from '../apps/consumer/src/sandbox.js';

const ROOM_CODE = 'sala-e2e-integracao';
const MOCK_MODELS = ['qwen3:8b', 'llama3.1:8b'];
const TEST_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Helpers de espera (evento/broadcast com timeout) para evitar flakiness
// ---------------------------------------------------------------------------

function waitEvent<T>(emitter: EventEmitter, event: string, timeoutMs = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`timeout aguardando evento '${event}'`));
    }, timeoutMs);
    const handler = (payload: T): void => {
      clearTimeout(timer);
      resolve(payload);
    };
    emitter.once(event, handler);
  });
}

/** Hub da GUI stubado: captura broadcasts e injeta eventos da GUI. */
class StubHub extends EventEmitter implements GuiHub {
  readonly sent: GuiMessage[] = [];

  broadcast(msg: GuiMessage): void {
    this.sent.push(msg);
    this.emit('broadcast', msg);
  }

  waitFor(
    type: string,
    pred: (msg: GuiMessage) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<GuiMessage> {
    const found = this.sent.find((m) => m.type === type && pred(m));
    if (found) return Promise.resolve(found);
    return new Promise<GuiMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('broadcast', handler);
        const received = this.sent.map((m) => m.type).join(', ') || '(nenhum)';
        reject(new Error(`timeout aguardando broadcast '${type}' — recebidos: ${received}`));
      }, timeoutMs);
      const handler = (msg: GuiMessage): void => {
        if (msg.type !== type || !pred(msg)) return;
        clearTimeout(timer);
        this.off('broadcast', handler);
        resolve(msg);
      };
      this.on('broadcast', handler);
    });
  }
}

// ---------------------------------------------------------------------------
// Ollama mockado (node:http): /api/tags + /api/chat NDJSON scriptado
// ---------------------------------------------------------------------------

interface ChatRequest {
  model?: string;
  messages?: Array<{ role: string; content: string; tool_calls?: unknown[] }>;
}

interface OllamaMock {
  server: Server;
  url: string;
  chatRequests: ChatRequest[];
}

function ndjson(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

/** Resposta de chat que pede um tool_call e encerra. */
function toolCallResponse(name: string, args: Record<string, unknown>): string[] {
  return [
    ndjson({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false }),
    ndjson({ message: { role: 'assistant', content: '' }, done: true }),
  ];
}

/** Resposta de chat com texto final (token único). */
function finalTextResponse(text: string): string[] {
  return [
    ndjson({ message: { role: 'assistant', content: text }, done: false }),
    ndjson({ message: { role: 'assistant', content: '' }, done: true }),
  ];
}

async function startOllamaMock(chatScript: string[][]): Promise<OllamaMock> {
  const chatRequests: ChatRequest[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: MOCK_MODELS.map((name) => ({ name })) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        chatRequests.push(JSON.parse(body) as ChatRequest);
        const lines = chatScript.shift();
        if (!lines) {
          res.writeHead(500, { 'content-type': 'application/x-ndjson' });
          res.end(ndjson({ error: 'sem resposta scriptada para esta chamada' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (const line of lines) res.write(line);
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, chatRequests };
}

// ---------------------------------------------------------------------------
// Stack completa: relay real + host real + consumer real
// ---------------------------------------------------------------------------

interface Stack {
  relay: RelayServer;
  ollama: OllamaMock;
  host: HostSession;
  session: Session;
  permissions: PermissionEngine;
  hub: StubHub;
  dir: string;
  hostFingerprint: string;
  consumerErrors: Error[];
}

async function startStack(chatScript: string[][]): Promise<Stack> {
  // Relay real em porta aleatória
  const relay = createRelayServer({ port: 0 });
  await once(relay.server, 'listening');
  const relayUrl = `ws://127.0.0.1:${relay.port()}/ws`;

  // Ollama mockado
  const ollama = await startOllamaMock(chatScript);

  // Pasta temporária permitida pelo sandbox do consumer
  const dir = await mkdtemp(path.join(tmpdir(), 'httpcoder-e2e-'));

  // Host real: HostSession + AgentLoop + OllamaClient apontando para o mock
  let hostFingerprint = '';
  let agent!: AgentLoop;
  const host = new HostSession(
    {
      serverUrl: relayUrl,
      roomCode: ROOM_CODE,
      backoffDelays: [50, 100],
      confirmFingerprint: async (fp) => {
        hostFingerprint = fp;
        return true;
      },
    },
    { onMessage: (msg) => void agent.handleMessage(msg) },
  );
  agent = new AgentLoop({
    ollama: new OllamaClient(ollama.url),
    defaultModel: 'qwen3:8b',
    session: host,
  });
  const hostConnect = host.connect();

  // Consumer real: Session + Bridge + Sandbox + PermissionEngine + hub stubado
  const consumerErrors: Error[] = [];
  const session = new Session({
    serverUrl: relayUrl,
    roomCode: ROOM_CODE,
    backoffMs: () => 50,
  });
  session.on('error', (err) => consumerErrors.push(err));
  // TOFU: sem pin no config, a sessão gateia até a decisão do usuário — a E2E auto-confirma
  session.on('fingerprint-confirm', () => session.resolveFingerprint('confirm'));
  const sandbox = await Sandbox.create({
    allowedPaths: [dir],
    allowedCommands: ['echo'],
    cwd: dir,
  });
  const permissions = new PermissionEngine();
  const hub = new StubHub();
  new Bridge({ session, sandbox, permissions, hub });
  session.connect();

  // Handshake X25519 completo nos dois lados
  await Promise.all([hostConnect, waitEvent(session, 'ready')]);

  return { relay, ollama, host, session, permissions, hub, dir, hostFingerprint, consumerErrors };
}

const stacks: Stack[] = [];

async function makeStack(chatScript: string[][]): Promise<Stack> {
  const stack = await startStack(chatScript);
  stacks.push(stack);
  return stack;
}

afterEach(async () => {
  const pending = stacks.splice(0);
  for (const stack of pending) {
    stack.session.close();
    stack.host.close();
    stack.ollama.server.closeAllConnections();
    await Promise.all([
      stack.relay.close(),
      new Promise<void>((resolve) => stack.ollama.server.close(() => resolve())),
    ]);
    await rm(stack.dir, { recursive: true, force: true });
  }
});

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cenários
// ---------------------------------------------------------------------------

describe('e2e: relay + host + consumer', () => {
  it(
    'fluxo feliz: write_file aprovado escreve o arquivo e o final chega ao consumer',
    async () => {
      const content = 'conteúdo escrito pelo fluxo e2e';
      const finalText = 'arquivo escrito com sucesso';
      // script montado depois de conhecermos o dir temporário: usa placeholder
      const script: string[][] = [];
      const stack = await makeStack(script);
      const target = path.join(stack.dir, 'saida.txt');
      script.push(toolCallResponse('write_file', { path: target, content }), finalTextResponse(finalText));

      const permissionRequest = stack.hub.waitFor('permission-request');
      stack.hub.emit('prompt', { type: 'prompt', text: 'escreva o arquivo para mim' });

      // a bridge pede permissão; o "usuário" aprova uma vez
      const request = await permissionRequest;
      expect(request.tool).toBe('write_file');
      stack.hub.emit('permission-result', { requestId: request.requestId, decision: 'once' });

      const final = await stack.hub.waitFor('final');
      expect(final.text).toBe(finalText);

      // o arquivo foi escrito de verdade no diretório temporário
      expect(await readFile(target, 'utf8')).toBe(content);

      // o tool-result ok alimentou a 2ª chamada ao modelo com role 'tool'
      expect(stack.ollama.chatRequests).toHaveLength(2);
      const toolMessage = stack.ollama.chatRequests[1]!.messages?.find((m) => m.role === 'tool');
      expect(toolMessage?.content).toContain('arquivo escrito');

      // fingerprint TOFU idêntico nos dois lados
      expect(stack.hostFingerprint).not.toBe('');
      expect(stack.session.fingerprint).toBe(stack.hostFingerprint);
      expect(stack.consumerErrors).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'permissão negada: arquivo não é escrito e tool-result ok:false alimenta o loop',
    async () => {
      const finalText = 'entendido, não escrevi nada';
      const script: string[][] = [];
      const stack = await makeStack(script);
      const target = path.join(stack.dir, 'negado.txt');
      script.push(toolCallResponse('write_file', { path: target, content: 'não deveria existir' }), finalTextResponse(finalText));

      const permissionRequest = stack.hub.waitFor('permission-request');
      stack.hub.emit('prompt', { type: 'prompt', text: 'escreva o arquivo' });

      const request = await permissionRequest;
      stack.hub.emit('permission-result', { requestId: request.requestId, decision: 'deny' });

      const final = await stack.hub.waitFor('final');
      expect(final.text).toBe(finalText);

      // arquivo NÃO existe
      expect(await fileExists(target)).toBe(false);

      // o host recebeu tool-result ok:false e repassou ao modelo como role 'tool'
      expect(stack.ollama.chatRequests).toHaveLength(2);
      const toolMessage = stack.ollama.chatRequests[1]!.messages?.find((m) => m.role === 'tool');
      expect(toolMessage?.content).toContain('permissão negada');
    },
    TEST_TIMEOUT,
  );

  it(
    'sandbox bloqueia path fora do allowedPath antes de qualquer permission-request',
    async () => {
      const finalText = 'o caminho foi recusado pelo sandbox';
      const script: string[][] = [];
      const stack = await makeStack(script);
      const outside = path.join(tmpdir(), `httpcoder-e2e-fora-${process.pid}.txt`);
      script.push(toolCallResponse('write_file', { path: outside, content: 'intruso' }), finalTextResponse(finalText));

      stack.hub.emit('prompt', { type: 'prompt', text: 'escreva fora da pasta permitida' });

      const final = await stack.hub.waitFor('final');
      expect(final.text).toBe(finalText);

      // nenhuma permissão foi pedida: o sandbox recusou antes
      expect(stack.hub.sent.filter((m) => m.type === 'permission-request')).toEqual([]);

      // tool-result ok:false voltou ao host e alimentou o loop
      expect(stack.ollama.chatRequests).toHaveLength(2);
      const toolMessage = stack.ollama.chatRequests[1]!.messages?.find((m) => m.role === 'tool');
      expect(toolMessage?.content).toContain('fora das pastas permitidas');

      // nada foi escrito fora do sandbox
      expect(await fileExists(outside)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'consumer pede a lista de modelos ao ficar pronto e recebe os modelos do mock',
    async () => {
      const stack = await makeStack([]);

      // a bridge envia model-list-request automaticamente no status 'ready'
      const models = await stack.hub.waitFor('models');
      expect(models.models).toEqual(MOCK_MODELS);

      // e não consumiu nenhuma chamada de chat
      expect(stack.ollama.chatRequests).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});
