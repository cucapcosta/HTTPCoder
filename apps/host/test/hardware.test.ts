import { describe, expect, it } from 'vitest';
import {
  checkHardwareAndModel,
  detectNvidiaGpu,
  parseNvidiaSmiCsv,
  recommendModel,
  type ExecFileAsync,
} from '../src/hardware.js';

describe('parseNvidiaSmiCsv', () => {
  it('parseia uma GPU', () => {
    expect(parseNvidiaSmiCsv('NVIDIA GeForce RTX 4090, 24564 MiB\n')).toEqual([
      { name: 'NVIDIA GeForce RTX 4090', vramMiB: 24564 },
    ]);
  });

  it('parseia múltiplas GPUs e ignora linhas vazias', () => {
    const out = 'NVIDIA A100-SXM4-40GB, 40960 MiB\n\nNVIDIA T4, 15360 MiB\n';
    expect(parseNvidiaSmiCsv(out)).toEqual([
      { name: 'NVIDIA A100-SXM4-40GB', vramMiB: 40960 },
      { name: 'NVIDIA T4', vramMiB: 15360 },
    ]);
  });

  it('ignora linhas malformadas', () => {
    expect(parseNvidiaSmiCsv('lixo sem memória\nNVIDIA T4, 15360 MiB\n')).toEqual([
      { name: 'NVIDIA T4', vramMiB: 15360 },
    ]);
  });
});

describe('detectNvidiaGpu', () => {
  const okExec =
    (stdout: string): ExecFileAsync =>
    async () => ({ stdout, stderr: '' });

  it('retorna a GPU de maior VRAM', async () => {
    const gpu = await detectNvidiaGpu(
      okExec('NVIDIA T4, 15360 MiB\nNVIDIA A100, 40960 MiB\n'),
    );
    expect(gpu).toEqual({ name: 'NVIDIA A100', vramMiB: 40960 });
  });

  it('retorna null quando nvidia-smi não existe (não lança)', async () => {
    const exec: ExecFileAsync = async () => {
      throw new Error('spawn nvidia-smi ENOENT');
    };
    await expect(detectNvidiaGpu(exec)).resolves.toBeNull();
  });

  it('retorna null em timeout ou saída vazia', async () => {
    const timeoutExec: ExecFileAsync = async () => {
      throw new Error('timed out');
    };
    await expect(detectNvidiaGpu(timeoutExec)).resolves.toBeNull();
    await expect(detectNvidiaGpu(okExec(''))).resolves.toBeNull();
  });
});

describe('recommendModel', () => {
  it.each([
    [40960, 'gpt-oss:20b'],
    [15360, 'gpt-oss:20b'],
    [11264, 'qwen2.5-coder:14b'],
    [12000, 'qwen2.5-coder:14b'],
    [7168, 'qwen2.5-coder:7b'],
    [8192, 'qwen2.5-coder:7b'],
    [5120, 'qwen3:4b'],
    [6144, 'qwen3:4b'],
    [4096, null],
    [null, null],
  ])('VRAM %s MiB → %s', (vram, expected) => {
    expect(recommendModel(vram)).toBe(expected);
  });
});

describe('checkHardwareAndModel', () => {
  function makeDeps(overrides: Record<string, unknown> = {}, askResult = false) {
    const logs: string[] = [];
    const asked: string[] = [];
    const pulled: string[] = [];
    const deps = {
      ollama: { listModels: async () => ['qwen3:4b'] },
      defaultModel: 'qwen3:4b',
      detectGpu: async () => ({ name: 'RTX 3060', vramMiB: 12288 }),
      ask: async (q: string) => {
        asked.push(q);
        return askResult;
      },
      pull: async (model: string) => {
        pulled.push(model);
      },
      log: (msg: string) => logs.push(msg),
      ...overrides,
    };
    return { deps, logs, asked, pulled };
  }

  it('sem GPU: avisa que CPU será lenta e não pergunta nem baixa nada', async () => {
    const { deps, logs, asked, pulled } = makeDeps({
      detectGpu: async () => null,
    });
    await checkHardwareAndModel(deps);
    expect(logs.some((l) => /CPU/i.test(l))).toBe(true);
    expect(asked).toEqual([]);
    expect(pulled).toEqual([]);
  });

  it('recomendado ausente + usuário aceita: roda ollama pull do modelo', async () => {
    const { deps, asked, pulled } = makeDeps(
      {
        detectGpu: async () => ({ name: 'RTX 3070', vramMiB: 8192 }),
        ollama: { listModels: async () => ['qwen3:4b'] },
      },
      true,
    );
    await checkHardwareAndModel(deps);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('qwen2.5-coder:7b');
    expect(pulled).toEqual(['qwen2.5-coder:7b']);
  });

  it('recomendado ausente + usuário recusa: não baixa', async () => {
    const { deps, asked, pulled } = makeDeps({
      detectGpu: async () => ({ name: 'RTX 3070', vramMiB: 8192 }),
      ollama: { listModels: async () => [] },
    });
    await checkHardwareAndModel(deps);
    expect(asked).toHaveLength(1);
    expect(pulled).toEqual([]);
  });

  it('recomendado instalado e defaultModel divergente: apenas loga a sugestão', async () => {
    const { deps, logs, asked, pulled } = makeDeps({
      detectGpu: async () => ({ name: 'RTX 3070', vramMiB: 8192 }),
      ollama: { listModels: async () => ['qwen2.5-coder:7b'] },
      defaultModel: 'qwen3:4b',
    });
    await checkHardwareAndModel(deps);
    expect(asked).toEqual([]);
    expect(pulled).toEqual([]);
    expect(logs.some((l) => l.includes('qwen2.5-coder:7b') && /sugest/i.test(l))).toBe(true);
  });

  it('recomendado instalado e defaultModel igual: nada a fazer', async () => {
    const { deps, logs, asked, pulled } = makeDeps({
      detectGpu: async () => ({ name: 'RTX 3070', vramMiB: 8192 }),
      ollama: { listModels: async () => ['qwen2.5-coder:7b'] },
      defaultModel: 'qwen2.5-coder:7b',
    });
    await checkHardwareAndModel(deps);
    expect(asked).toEqual([]);
    expect(pulled).toEqual([]);
    expect(logs.some((l) => /sugest/i.test(l))).toBe(false);
  });

  it('Ollama fora do ar: avisa e segue sem perguntar nem baixar', async () => {
    const { deps, logs, asked, pulled } = makeDeps({
      ollama: {
        listModels: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      },
    });
    await expect(checkHardwareAndModel(deps)).resolves.toBeUndefined();
    expect(logs.some((l) => /ollama/i.test(l))).toBe(true);
    expect(asked).toEqual([]);
    expect(pulled).toEqual([]);
  });

  it('falha no pull: avisa e não quebra o boot', async () => {
    const { deps, logs } = makeDeps({
      detectGpu: async () => ({ name: 'RTX 3070', vramMiB: 8192 }),
      ollama: { listModels: async () => [] },
      ask: async () => true,
      pull: async () => {
        throw new Error('pull falhou');
      },
    });
    await expect(checkHardwareAndModel(deps)).resolves.toBeUndefined();
    expect(logs.some((l) => /pull|falh/i.test(l))).toBe(true);
  });
});
