import { describe, expect, it } from 'vitest';
import {
  parseAppMessage,
  parseRelayMessage,
  serialize,
  type AppMessage,
  type RelayMessage,
} from '../src/messages.js';

describe('mensagens do relay (texto claro)', () => {
  it.each([
    { type: 'hello', role: 'host', room: 'a'.repeat(64) },
    { type: 'handshake', role: 'consumer', publicKey: 'cHVi' },
    { type: 'frame', data: 'ZnJhbWU=' },
    { type: 'error', message: 'sala ocupada' },
    { type: 'peer-connected', role: 'host' },
    { type: 'peer-disconnected', role: 'consumer' },
  ] satisfies RelayMessage[])('faz round-trip de %s', (msg) => {
    expect(parseRelayMessage(serialize(msg))).toEqual(msg);
  });

  it('rejeita JSON inválido', () => {
    expect(() => parseRelayMessage('não é json')).toThrow();
  });

  it('rejeita tipo desconhecido', () => {
    expect(() => parseRelayMessage(JSON.stringify({ type: 'hack' }))).toThrow(/tipo/);
  });

  it('rejeita mensagem sem campo obrigatório', () => {
    expect(() => parseRelayMessage(JSON.stringify({ type: 'hello', role: 'host' }))).toThrow();
  });
});

describe('mensagens de aplicação (dentro do frame criptografado)', () => {
  it.each([
    { type: 'prompt', id: '1', text: 'liste os arquivos', model: 'qwen2.5-coder:14b' },
    { type: 'token', id: '1', text: '...' },
    { type: 'tool-call', id: '1', callId: 'c1', name: 'read_file', args: { path: 'a.ts' } },
    { type: 'tool-result', id: '1', callId: 'c1', ok: true, output: 'conteúdo' },
    { type: 'final', id: '1', text: 'pronto' },
    { type: 'model-list-request' },
    { type: 'model-list', models: ['llama3.1:8b'] },
    { type: 'app-error', id: '1', message: 'falhou' },
  ] satisfies AppMessage[])('faz round-trip de %s', (msg) => {
    expect(parseAppMessage(serialize(msg))).toEqual(msg);
  });

  it('rejeita tool-call sem nome', () => {
    expect(() =>
      parseAppMessage(JSON.stringify({ type: 'tool-call', id: '1', callId: 'c1', args: {} })),
    ).toThrow();
  });
});
