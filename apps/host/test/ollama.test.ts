import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OllamaClient, TOOL_DEFINITIONS } from '../src/ollama.js';

type Route = (
  body: unknown,
  respond: (status: number, chunks: string[]) => void,
) => void;

let server: Server;
let baseUrl: string;
let routes: Record<string, Route>;
let lastChatBody: Record<string, unknown>;

beforeEach(async () => {
  routes = {};
  server = createServer((req, res) => {
    const respond = (status: number, chunks: string[]) => {
      res.writeHead(status, { 'content-type': 'application/x-ndjson' });
      for (const chunk of chunks) res.write(chunk);
      res.end();
    };
    const route = routes[`${req.method} ${req.url}`];
    if (!route) {
      respond(404, [JSON.stringify({ error: 'rota não mockada' })]);
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined;
      if (req.url === '/api/chat') lastChatBody = parsed;
      route(parsed, respond);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function ndjson(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

describe('listModels', () => {
  it('retorna os nomes dos modelos instalados', async () => {
    routes['GET /api/tags'] = (_body, respond) =>
      respond(200, [
        JSON.stringify({
          models: [
            { name: 'qwen3:8b', size: 1 },
            { name: 'llama3.1:8b', size: 2 },
          ],
        }),
      ]);
    const client = new OllamaClient(baseUrl);
    expect(await client.listModels()).toEqual(['qwen3:8b', 'llama3.1:8b']);
  });

  it('lança erro quando o Ollama responde com falha', async () => {
    routes['GET /api/tags'] = (_body, respond) => respond(500, ['boom']);
    const client = new OllamaClient(baseUrl);
    await expect(client.listModels()).rejects.toThrow(/500/);
  });
});

describe('chat', () => {
  it('faz streaming de tokens via onToken e acumula o conteúdo', async () => {
    routes['POST /api/chat'] = (_body, respond) =>
      respond(200, [
        ndjson({ message: { role: 'assistant', content: 'Olá' }, done: false }),
        ndjson({ message: { role: 'assistant', content: ', mundo' }, done: false }),
        ndjson({ message: { role: 'assistant', content: '!' }, done: true }),
      ]);
    const client = new OllamaClient(baseUrl);
    const tokens: string[] = [];
    const result = await client.chat({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'oi' }],
      tools: TOOL_DEFINITIONS,
      onToken: (t) => tokens.push(t),
    });
    expect(tokens).toEqual(['Olá', ', mundo', '!']);
    expect(result.content).toBe('Olá, mundo!');
    expect(result.toolCalls).toEqual([]);
    // corpo enviado ao Ollama
    expect(lastChatBody.model).toBe('qwen3:8b');
    expect(lastChatBody.stream).toBe(true);
    expect(lastChatBody.messages).toEqual([{ role: 'user', content: 'oi' }]);
    expect(lastChatBody.tools).toEqual(TOOL_DEFINITIONS);
  });

  it('acumula tool_calls presentes na resposta', async () => {
    routes['POST /api/chat'] = (_body, respond) =>
      respond(200, [
        ndjson({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'read_file', arguments: { path: 'a.txt' } } },
              { function: { name: 'run_command', arguments: { command: 'git', args: ['status'] } } },
            ],
          },
          done: true,
        }),
      ]);
    const client = new OllamaClient(baseUrl);
    const result = await client.chat({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'leia a.txt' }],
    });
    expect(result.content).toBe('');
    expect(result.toolCalls).toEqual([
      { function: { name: 'read_file', arguments: { path: 'a.txt' } } },
      { function: { name: 'run_command', arguments: { command: 'git', args: ['status'] } } },
    ]);
  });

  it('tolera linhas NDJSON cortadas entre chunks TCP', async () => {
    const line1 = ndjson({ message: { role: 'assistant', content: 'metade' }, done: false });
    const line2 = ndjson({ message: { role: 'assistant', content: '!' }, done: true });
    const cut = Math.floor(line1.length / 2);
    routes['POST /api/chat'] = (_body, respond) =>
      respond(200, [line1.slice(0, cut), line1.slice(cut) + line2]);
    const client = new OllamaClient(baseUrl);
    const result = await client.chat({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'oi' }],
    });
    expect(result.content).toBe('metade!');
  });

  it('lança erro em resposta não-200', async () => {
    routes['POST /api/chat'] = (_body, respond) =>
      respond(500, [JSON.stringify({ error: 'modelo não encontrado' })]);
    const client = new OllamaClient(baseUrl);
    await expect(
      client.chat({ model: 'nope', messages: [{ role: 'user', content: 'oi' }] }),
    ).rejects.toThrow(/500/);
  });
});

describe('TOOL_DEFINITIONS', () => {
  it('define as 4 tools no formato do Ollama', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    expect(names.sort()).toEqual(['list_dir', 'read_file', 'run_command', 'write_file']);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.type).toBe('function');
      expect(tool.function.parameters.type).toBe('object');
    }
  });
});
