import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sandbox } from '../src/sandbox.js';

let root: string;
let sandbox: Sandbox;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'consumer-sandbox-'));
  await mkdir(path.join(root, 'allowed', 'sub'), { recursive: true });
  await mkdir(path.join(root, 'outside'), { recursive: true });
  await writeFile(path.join(root, 'allowed', 'sub', 'file.txt'), 'conteudo de teste');
  await writeFile(path.join(root, 'outside', 'secret.txt'), 'segredo');
  // symlink dentro da pasta permitida apontando para fora
  await symlink(
    path.join(root, 'outside', 'secret.txt'),
    path.join(root, 'allowed', 'link-secret.txt'),
  );
  sandbox = await Sandbox.create({
    allowedPaths: ['allowed'],
    allowedCommands: ['echo'],
    cwd: root,
    commandTimeoutMs: 5000,
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('sandbox — arquivos', () => {
  it('lê arquivo dentro de allowedPath', async () => {
    const res = await sandbox.execute('read_file', { path: 'allowed/sub/file.txt' });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('conteudo de teste');
  });

  it('rejeita caminho com .. que escapa da pasta permitida', async () => {
    const res = await sandbox.execute('read_file', { path: 'allowed/../../outside/secret.txt' });
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/fora das pastas permitidas/);
  });

  it('rejeita caminho absoluto fora da pasta permitida', async () => {
    const res = await sandbox.execute('read_file', { path: path.join(root, 'outside', 'secret.txt') });
    expect(res.ok).toBe(false);
  });

  it('rejeita symlink que aponta para fora da pasta permitida', async () => {
    const res = await sandbox.execute('read_file', { path: 'allowed/link-secret.txt' });
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/fora das pastas permitidas/);
  });

  it('escreve arquivo dentro de allowedPath', async () => {
    const res = await sandbox.execute('write_file', {
      path: 'allowed/novo.txt',
      content: 'gravado',
    });
    expect(res.ok).toBe(true);
    const lido = await sandbox.execute('read_file', { path: 'allowed/novo.txt' });
    expect(lido.output).toContain('gravado');
  });

  it('lista diretório dentro de allowedPath', async () => {
    const res = await sandbox.execute('list_dir', { path: 'allowed' });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('sub');
  });

  it('rejeita ferramenta desconhecida', async () => {
    const res = await sandbox.execute('delete_everything', {});
    expect(res.ok).toBe(false);
  });
});

describe('sandbox — comandos', () => {
  it('executa comando da allowlist e captura stdout', async () => {
    const res = await sandbox.execute('run_command', { command: 'echo ola-mundo' });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('ola-mundo');
  });

  it('rejeita executável fora da allowlist', async () => {
    const res = await sandbox.execute('run_command', { command: 'rm -rf /' });
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/não está na lista de comandos permitidos/);
  });

  it('não usa shell: metacaracteres não são interpretados', async () => {
    const res = await sandbox.execute('run_command', { command: 'echo oi; rm x' });
    expect(res.ok).toBe(true);
    // sem shell, "oi; rm x" vira argumento literal do echo
    expect(res.output).toContain('oi; rm x');
  });
});
