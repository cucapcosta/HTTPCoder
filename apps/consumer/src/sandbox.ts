import { execFile } from 'node:child_process';
import { realpath, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Limite de saída das tools, para não explodir o contexto do modelo. */
const MAX_OUTPUT = 64 * 1024;

export interface SandboxOptions {
  /** Pastas permitidas (relativas a cwd ou absolutas) */
  allowedPaths: string[];
  /** Executáveis permitidos (primeiro token do comando) */
  allowedCommands: string[];
  /** Base para resolver caminhos relativos (default: process.cwd()) */
  cwd?: string;
  /** Timeout de run_command em ms (default: 30000) */
  commandTimeoutMs?: number;
}

export interface ToolOutput {
  ok: boolean;
  output: string;
}

export class SandboxError extends Error {}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n... (saída truncada em ${MAX_OUTPUT} caracteres)`;
}

/**
 * Executor das tools agênticas (read_file, write_file, list_dir, run_command)
 * confinado às allowedPaths/allowedCommands do config.
 */
export class Sandbox {
  private readonly allowedRoots: string[];
  private readonly allowedCommands: Set<string>;
  private readonly cwd: string;
  private readonly commandTimeoutMs: number;

  private constructor(allowedRoots: string[], opts: SandboxOptions) {
    this.allowedRoots = allowedRoots;
    this.allowedCommands = new Set(opts.allowedCommands);
    this.cwd = opts.cwd ?? process.cwd();
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 30_000;
  }

  /** Cria o sandbox resolvendo symlinks das pastas permitidas. */
  static async create(opts: SandboxOptions): Promise<Sandbox> {
    const cwd = opts.cwd ?? process.cwd();
    const roots = await Promise.all(
      opts.allowedPaths.map(async (p) => {
        const resolved = path.resolve(cwd, p);
        try {
          return await realpath(resolved);
        } catch {
          throw new SandboxError(`pasta permitida não existe: ${p}`);
        }
      }),
    );
    return new Sandbox(roots, { ...opts, cwd });
  }

  /** Confere se o caminho está dentro de alguma pasta permitida (com fronteira de separador). */
  private isInside(candidate: string): boolean {
    return this.allowedRoots.some(
      (root) => candidate === root || candidate.startsWith(root + path.sep),
    );
  }

  /**
   * Resolve um caminho vindo do modelo e valida o confinamento.
   * Usa realpath quando o arquivo (ou o diretório pai) existe, para barrar symlinks.
   */
  async resolvePath(input: string): Promise<string> {
    if (typeof input !== 'string' || input.length === 0) {
      throw new SandboxError('caminho inválido');
    }
    const resolved = path.resolve(this.cwd, input);
    if (!this.isInside(resolved)) {
      throw new SandboxError(`caminho fora das pastas permitidas: ${input}`);
    }
    try {
      const real = await realpath(resolved);
      if (!this.isInside(real)) {
        throw new SandboxError(`caminho (via symlink) fora das pastas permitidas: ${input}`);
      }
      return real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // arquivo novo (write_file): valida o diretório pai real
      const parentReal = await realpath(path.dirname(resolved)).catch(() => {
        throw new SandboxError(`diretório não existe: ${path.dirname(resolved)}`);
      });
      if (!this.isInside(parentReal)) {
        throw new SandboxError(`caminho (via symlink) fora das pastas permitidas: ${input}`);
      }
      return path.join(parentReal, path.basename(resolved));
    }
  }

  /** Extrai o executável (primeiro token) e confere a allowlist. */
  checkCommand(command: string): { executable: string; args: string[] } {
    const tokens = command.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) throw new SandboxError('comando vazio');
    const executable = tokens[0]!;
    if (!this.allowedCommands.has(executable)) {
      throw new SandboxError(`executável '${executable}' não está na lista de comandos permitidos`);
    }
    return { executable, args: tokens.slice(1) };
  }

  /** Executa uma tool-call já validada em nome e devolve saída textual. */
  async execute(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
    try {
      switch (name) {
        case 'read_file':
          return { ok: true, output: truncate(await readFile(await this.resolvePath(String(args.path)), 'utf8')) };
        case 'write_file': {
          const target = await this.resolvePath(String(args.path));
          const content = String(args.content ?? '');
          await writeFile(target, content, 'utf8');
          return { ok: true, output: `arquivo escrito: ${target} (${content.length} caracteres)` };
        }
        case 'list_dir': {
          const target = await this.resolvePath(String(args.path ?? '.'));
          const entries = await readdir(target, { withFileTypes: true });
          const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
          return { ok: true, output: truncate(lines.join('\n')) };
        }
        case 'run_command': {
          const { executable, args: cmdArgs } = this.checkCommand(String(args.command ?? ''));
          try {
            const { stdout, stderr } = await execFileAsync(executable, cmdArgs, {
              cwd: this.cwd,
              timeout: this.commandTimeoutMs,
              maxBuffer: 4 * 1024 * 1024,
              // sem shell: metacaracteres não são interpretados
              shell: false,
            });
            const out = [stdout, stderr].filter(Boolean).join('');
            return { ok: true, output: truncate(out) || '(sem saída)' };
          } catch (err) {
            const e = err as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
            const detail = [e.stdout, e.stderr, e.killed ? 'timeout excedido' : e.message]
              .filter(Boolean)
              .join('\n');
            return { ok: false, output: truncate(detail) };
          }
        }
        default:
          return { ok: false, output: `ferramenta desconhecida: ${name}` };
      }
    } catch (err) {
      return { ok: false, output: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Lê o conteúdo atual de um arquivo (para o diff do cartão de permissão). */
  async readCurrentContent(resolvedPath: string): Promise<string | undefined> {
    try {
      await stat(resolvedPath);
      return await readFile(resolvedPath, 'utf8');
    } catch {
      return undefined;
    }
  }
}
