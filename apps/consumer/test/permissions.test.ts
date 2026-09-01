import { describe, expect, it } from 'vitest';
import { PermissionEngine } from '../src/permissions.js';

describe('PermissionEngine', () => {
  it('nega ferramenta desconhecida sem perguntar', () => {
    const p = new PermissionEngine();
    expect(p.evaluate('delete_everything', '/tmp/x')).toBe('deny');
  });

  it('pede confirmação para ferramenta conhecida sem regra', () => {
    const p = new PermissionEngine();
    expect(p.evaluate('read_file', '/tmp/x')).toBe('ask');
  });

  it('fluxo ask → once: permite mas não persiste regra', async () => {
    const p = new PermissionEngine();
    let asked: { requestId: string; tool: string; target: string } | undefined;
    p.on('ask', (req) => {
      asked = req;
      p.resolve(req.requestId, 'once');
    });
    const allowed = await p.authorize('read_file', '/tmp/x');
    expect(allowed).toBe(true);
    expect(asked?.tool).toBe('read_file');
    expect(asked?.target).toBe('/tmp/x');
    // "uma vez" não cria regra: volta a perguntar
    expect(p.evaluate('read_file', '/tmp/x')).toBe('ask');
  });

  it('fluxo ask → always: regra persiste por par (tool, alvo)', async () => {
    const p = new PermissionEngine();
    p.on('ask', (req) => p.resolve(req.requestId, 'always'));
    expect(await p.authorize('write_file', '/tmp/a.txt')).toBe(true);
    expect(p.evaluate('write_file', '/tmp/a.txt')).toBe('allow');
    // outro alvo da mesma tool ainda pergunta
    expect(p.evaluate('write_file', '/tmp/b.txt')).toBe('ask');
    // mesmo alvo, outra tool, ainda pergunta
    expect(p.evaluate('read_file', '/tmp/a.txt')).toBe('ask');
  });

  it('fluxo ask → deny: recusa e não persiste', async () => {
    const p = new PermissionEngine();
    p.on('ask', (req) => p.resolve(req.requestId, 'deny'));
    expect(await p.authorize('run_command', 'echo')).toBe(false);
    expect(p.evaluate('run_command', 'echo')).toBe('ask');
  });

  it('resolve com requestId desconhecido retorna false', () => {
    const p = new PermissionEngine();
    expect(p.resolve('nao-existe', 'once')).toBe(false);
  });
});
