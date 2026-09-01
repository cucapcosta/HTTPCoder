import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppMessage } from '@httpcoder/protocol';
import { AgentLoop } from '../src/agent.js';
import { OllamaClient } from '../src/ollama.js';

interface ScriptedChat {
  status?: number;
  lines: unknown[];
}

let server: Server;
let ollama: OllamaClient;
let chatScript: ScriptedChat[];
let chatRequests: Array<Record<string, unknown>>;
let sent: AppMessage[];
let agent: AgentLoop;

function ndjson(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

beforeEach(async () => {
  chatScript = [];
  chatRequests = [];
  sent = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.1:8b' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        chatRequests.push(JSON.parse(body));
        const next = chatScript.shift();
        if (!next) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'sem resposta scriptada' }));
          return;
        }
        res.writeHead(next.status ?? 200, { 'content-type': 'application/x-ndjson' });
        for (const line of next.lines) res.write(typeof line === 'string' ? line : ndjson(line));
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  ollama = new OllamaClient(`http://127.0.0.1:${port}`);
  agent = new AgentLoop({
    ollama,
    defaultModel: 'qwen3:8b',
    session: { send: (msg) => sent.push(msg) },
  });
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function sentOfType<T extends AppMessage['type']>(type: T): Extract<AppMessage, { type: T }>[] {
  return sent.filter((m) => m.type === type) as Extract<AppMessage, { type: T }>[];
}

function assistantLine(content: string, done: boolean, extra: object = {}): unknown {
  return { message: { role: 'assistant', content, ...extra }, done };
}

describe('AgentLoop', () => {
  it('prompt simples: stream de tokens e final com o texto completo', async () => {
    chatScript.push({
      lines: [assistantLine('A resposta ', false), assistantLine('é 42.', true)],
    });
    await agent.handleMessage({ type: 'prompt', id: 'p1', text: 'quanto é 6x7?' });

    expect(sentOfType('token')).toEqual([
      { type: 'token', id: 'p1', text: 'A resposta ' },
      { type: 'token', id: 'p1', text: 'é 42.' },
    ]);
    expect(sentOfType('final')).toEqual([{ type: 'final', id: 'p1', text: 'A resposta é 42.' }]);
    expect(chatRequests[0]!.model).toBe('qwen3:8b');
    expect(chatRequests[0]!.messages).toEqual([
      { role: 'user', content: 'quanto é 6x7?' },
    ]);
    expect(Array.isArray(chatRequests[0]!.tools)).toBe(true);
  });

  it('respeita o model do prompt quando presente', async () => {
    chatScript.push({ lines: [assistantLine('ok', true)] });
    await agent.handleMessage({ type: 'prompt', id: 'p2', text: 'oi', model: 'llama3.1:8b' });
    expect(chatRequests[0]!.model).toBe('llama3.1:8b');
  });

  it('loop agêntico: tool-call → tool-result → continua até o final', async () => {
    chatScript.push({
      lines: [
        assistantLine('', true, {
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
        }),
      ],
    });
    chatScript.push({ lines: [assistantLine('O arquivo diz: olá', true)] });

    const done = agent.handleMessage({ type: 'prompt', id: 'p3', text: 'leia a.txt' });

    // aguarda o tool-call ser enviado ao consumer
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (sentOfType('tool-call').length > 0) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    const toolCall = sentOfType('tool-call')[0]!;
    expect(toolCall.id).toBe('p3');
    expect(toolCall.name).toBe('read_file');
    expect(toolCall.args).toEqual({ path: 'a.txt' });
    expect(toolCall.callId).toBeTruthy();
    // ainda não há final: o loop espera o tool-result
    expect(sentOfType('final')).toEqual([]);

    await agent.handleMessage({
      type: 'tool-result',
      id: 'p3',
      callId: toolCall.callId,
      ok: true,
      output: 'olá',
    });
    await done;

    // 2ª chamada ao Ollama carrega o assistant com tool_calls e a resposta role 'tool'
    const secondMessages = chatRequests[1]!.messages as Array<Record<string, unknown>>;
    expect(secondMessages.at(-2)).toMatchObject({
      role: 'assistant',
      tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
    });
    expect(secondMessages.at(-1)).toEqual({ role: 'tool', content: 'olá' });

    expect(sentOfType('final')).toEqual([
      { type: 'final', id: 'p3', text: 'O arquivo diz: olá' },
    ]);
  });

  it('tool-result com ok=false também alimenta o loop', async () => {
    chatScript.push({
      lines: [
        assistantLine('', true, {
          tool_calls: [{ function: { name: 'run_command', arguments: { command: 'rm', args: ['-rf', '/'] } } }],
        }),
      ],
    });
    chatScript.push({ lines: [assistantLine('Entendido, não vou executar.', true)] });

    const done = agent.handleMessage({ type: 'prompt', id: 'p4', text: 'apague tudo' });
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (sentOfType('tool-call').length > 0) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    const toolCall = sentOfType('tool-call')[0]!;
    await agent.handleMessage({
      type: 'tool-result',
      id: 'p4',
      callId: toolCall.callId,
      ok: false,
      output: 'permissão negada pelo usuário',
    });
    await done;

    const secondMessages = chatRequests[1]!.messages as Array<Record<string, unknown>>;
    expect(secondMessages.at(-1)).toEqual({
      role: 'tool',
      content: 'permissão negada pelo usuário',
    });
    expect(sentOfType('final')).toEqual([
      { type: 'final', id: 'p4', text: 'Entendido, não vou executar.' },
    ]);
  });

  it('model-list-request responde com os modelos instalados', async () => {
    await agent.handleMessage({ type: 'model-list-request' });
    expect(sentOfType('model-list')).toEqual([
      { type: 'model-list', models: ['qwen3:8b', 'llama3.1:8b'] },
    ]);
  });

  it('erro do Ollama vira app-error com o id do prompt', async () => {
    chatScript.push({ status: 500, lines: [JSON.stringify({ error: 'modelo não encontrado' })] });
    await agent.handleMessage({ type: 'prompt', id: 'p5', text: 'oi', model: 'nope:latest' });
    const errors = sentOfType('app-error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.id).toBe('p5');
    expect(errors[0]!.message).toMatch(/500/);
    expect(sentOfType('final')).toEqual([]);
  });

  it('tool-result sem waiter correspondente é ignorado', async () => {
    await agent.handleMessage({
      type: 'tool-result',
      id: 'ninguém',
      callId: 'desconhecido',
      ok: true,
      output: 'x',
    });
    expect(sent).toEqual([]);
  });
});
