import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

/**
 * Detecção de hardware (GPU NVIDIA via nvidia-smi) e sugestão de modelo no
 * boot do host. Nada aqui pode derrubar o boot: qualquer falha vira log.
 */

export interface GpuInfo {
  name: string;
  vramMiB: number;
}

export type ExecFileAsync = (
  cmd: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFileAsync = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) =>
      err ? reject(err) : resolve({ stdout, stderr }),
    );
  });

/** Parseia a saída CSV de `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader`. */
export function parseNvidiaSmiCsv(output: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const [name, memory] = trimmed.split(',');
    const match = /(\d+)\s*MiB/i.exec(memory ?? '');
    if (!name?.trim() || !match) continue; // linha malformada: ignora
    gpus.push({ name: name.trim(), vramMiB: Number(match[1]) });
  }
  return gpus;
}

/**
 * Detecta GPU NVIDIA e VRAM. Retorna a GPU de maior VRAM, ou null se
 * nvidia-smi não existir, estourar o timeout ou não reportar nada.
 */
export async function detectNvidiaGpu(exec: ExecFileAsync = defaultExec): Promise<GpuInfo | null> {
  try {
    const { stdout } = await exec(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader'],
      { timeout: 3000 },
    );
    const gpus = parseNvidiaSmiCsv(stdout);
    if (gpus.length === 0) return null;
    return gpus.reduce((best, gpu) => (gpu.vramMiB > best.vramMiB ? gpu : best));
  } catch {
    return null;
  }
}

/**
 * Tabela de recomendação por VRAM, mirando uso agêntico com tool calling.
 * Abaixo de 5GB (ou sem GPU) não há recomendação — só o aviso de CPU lenta.
 */
export function recommendModel(vramMiB: number | null): string | null {
  if (vramMiB === null) return null;
  if (vramMiB >= 15 * 1024) return 'gpt-oss:20b';
  if (vramMiB >= 11 * 1024) return 'qwen2.5-coder:14b';
  if (vramMiB >= 7 * 1024) return 'qwen2.5-coder:7b';
  if (vramMiB >= 5 * 1024) return 'qwen3:4b';
  return null;
}

async function defaultAsk(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [s/N] `);
    return answer.trim().toLowerCase() === 's';
  } finally {
    rl.close();
  }
}

function defaultPull(model: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ollama', ['pull', model], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`ollama pull saiu com código ${code}`)),
    );
  });
}

export interface HardwareBootDeps {
  ollama: { listModels(): Promise<string[]> };
  defaultModel: string;
  detectGpu?: () => Promise<GpuInfo | null>;
  ask?: (question: string) => Promise<boolean>;
  pull?: (model: string) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * Rotina de boot: detecta GPU, compara com os modelos instalados no Ollama,
 * oferece baixar o recomendado e sugere ajuste do defaultModel. Nunca lança.
 */
export async function checkHardwareAndModel(deps: HardwareBootDeps): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.log(msg));

  const gpu = await (deps.detectGpu ?? (() => detectNvidiaGpu()))();
  if (gpu) {
    log(`[host] GPU detectada: ${gpu.name} (${gpu.vramMiB} MiB de VRAM)`);
  } else {
    log('[host] nenhuma GPU NVIDIA detectada (nvidia-smi ausente); inferência em CPU será lenta');
  }

  const recommended = recommendModel(gpu?.vramMiB ?? null);
  if (!recommended) {
    if (gpu) log('[host] VRAM abaixo de 5GB: sem recomendação de modelo; CPU será lenta');
    return;
  }

  let models: string[];
  try {
    models = await deps.ollama.listModels();
  } catch {
    log('[host] Ollama fora do ar: não foi possível verificar os modelos instalados; seguindo assim mesmo');
    return;
  }

  if (!models.includes(recommended)) {
    const ask = deps.ask ?? defaultAsk;
    const yes = await ask(`Modelo recomendado '${recommended}' não está instalado. Baixar agora?`);
    if (!yes) return;
    const pull = deps.pull ?? defaultPull;
    try {
      await pull(recommended);
      log(`[host] modelo '${recommended}' baixado`);
    } catch (err) {
      log(`[host] falha no 'ollama pull ${recommended}': ${err instanceof Error ? err.message : err}`);
    }
    return;
  }

  if (deps.defaultModel !== recommended) {
    log(
      `[host] sugestão: para a sua GPU o modelo recomendado é '${recommended}' ` +
        `(defaultModel atual: '${deps.defaultModel}')`,
    );
  }
}
