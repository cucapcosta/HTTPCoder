import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

let dir: string | undefined;

afterEach(async () => {
  delete process.env.HTTPCODER_CONSUMER_CONFIG;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function writeConfig(data: unknown): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), 'consumer-config-'));
  const file = path.join(dir, 'consumer.config.json');
  await writeFile(file, JSON.stringify(data));
  return file;
}

const valid = {
  serverUrl: 'wss://relay.example.com/ws',
  roomCode: 'sala-secreta-123',
  allowedPaths: ['./projetos'],
  allowedCommands: ['git', 'echo'],
};

describe('loadConfig', () => {
  it('carrega config e aplica default de guiPort', async () => {
    const file = await writeConfig(valid);
    const cfg = loadConfig(file);
    expect(cfg.serverUrl).toBe(valid.serverUrl);
    expect(cfg.roomCode).toBe(valid.roomCode);
    expect(cfg.guiPort).toBe(4173);
    expect(cfg.allowedPaths).toEqual(['./projetos']);
    expect(cfg.allowedCommands).toEqual(['git', 'echo']);
    expect(cfg.fingerprintPin).toBeUndefined();
  });

  it('usa caminho da env HTTPCODER_CONSUMER_CONFIG quando não informado', async () => {
    const file = await writeConfig(valid);
    process.env.HTTPCODER_CONSUMER_CONFIG = file;
    const cfg = loadConfig();
    expect(cfg.roomCode).toBe(valid.roomCode);
  });

  it('respeita guiPort e fingerprintPin explícitos', async () => {
    const file = await writeConfig({ ...valid, guiPort: 9999, fingerprintPin: 'AAAA BBBB' });
    const cfg = loadConfig(file);
    expect(cfg.guiPort).toBe(9999);
    expect(cfg.fingerprintPin).toBe('AAAA BBBB');
  });

  it('falha com mensagem clara quando arquivo não existe', () => {
    expect(() => loadConfig('/caminho/inexistente.json')).toThrow(/config/);
  });

  it('falha quando falta campo obrigatório', async () => {
    const file = await writeConfig({ serverUrl: 'wss://x' });
    expect(() => loadConfig(file)).toThrow(/roomCode/);
  });
});
