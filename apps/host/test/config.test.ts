import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadConfig,
  resolveConfigPath,
  saveFingerprintPin,
} from '../src/config.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HTTPCODER_HOST_CONFIG;
});

function writeConfig(obj: unknown): string {
  const path = join(dir, 'host.config.json');
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

const valid = {
  serverUrl: 'ws://relay.example.com/ws',
  roomCode: 'sala-secreta-123',
  defaultModel: 'qwen3:8b',
};

describe('resolveConfigPath', () => {
  it('usa HTTPCODER_HOST_CONFIG quando definida', () => {
    process.env.HTTPCODER_HOST_CONFIG = '/tmp/custom.json';
    expect(resolveConfigPath()).toBe('/tmp/custom.json');
  });

  it('cai para ./host.config.json sem a env', () => {
    expect(resolveConfigPath()).toBe('host.config.json');
  });
});

describe('loadConfig', () => {
  it('carrega config válida e aplica default do ollamaUrl', () => {
    const path = writeConfig(valid);
    const cfg = loadConfig(path);
    expect(cfg.serverUrl).toBe(valid.serverUrl);
    expect(cfg.roomCode).toBe(valid.roomCode);
    expect(cfg.defaultModel).toBe(valid.defaultModel);
    expect(cfg.ollamaUrl).toBe('http://localhost:11434');
    expect(cfg.fingerprintPin).toBeUndefined();
  });

  it('respeita ollamaUrl e fingerprintPin explícitos', () => {
    const path = writeConfig({
      ...valid,
      ollamaUrl: 'http://192.168.0.10:11434',
      fingerprintPin: 'ABCD 1234 EFGH 5678',
    });
    const cfg = loadConfig(path);
    expect(cfg.ollamaUrl).toBe('http://192.168.0.10:11434');
    expect(cfg.fingerprintPin).toBe('ABCD 1234 EFGH 5678');
  });

  it('falha com erro claro quando o arquivo não existe', () => {
    expect(() => loadConfig(join(dir, 'nope.json'))).toThrow(/config/i);
  });

  it.each(['serverUrl', 'roomCode', 'defaultModel'])(
    'exige o campo obrigatório %s',
    (field) => {
      const incomplete: Record<string, unknown> = { ...valid };
      delete incomplete[field];
      const path = writeConfig(incomplete);
      expect(() => loadConfig(path)).toThrow(new RegExp(field));
    },
  );

  it('rejeita serverUrl que não é ws:// nem wss://', () => {
    const path = writeConfig({ ...valid, serverUrl: 'http://relay.example.com' });
    expect(() => loadConfig(path)).toThrow(/serverUrl/);
  });

  it('rejeita fingerprintPin que não é string', () => {
    const path = writeConfig({ ...valid, fingerprintPin: 1234 });
    expect(() => loadConfig(path)).toThrow(/fingerprintPin/);
  });
});

describe('saveFingerprintPin', () => {
  it('grava o pin no arquivo preservando os demais campos', () => {
    const path = writeConfig(valid);
    saveFingerprintPin(path, 'AAAA BBBB CCCC DDDD');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.fingerprintPin).toBe('AAAA BBBB CCCC DDDD');
    expect(raw.serverUrl).toBe(valid.serverUrl);
    expect(raw.roomCode).toBe(valid.roomCode);
    expect(raw.defaultModel).toBe(valid.defaultModel);
  });
});
