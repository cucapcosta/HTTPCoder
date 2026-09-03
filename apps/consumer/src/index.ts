import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { loadOrCreateIdentity } from './identity.js';
import { Sandbox } from './sandbox.js';
import { PermissionEngine } from './permissions.js';
import { Session } from './session.js';
import { Bridge } from './bridge.js';
import { createGuiServer } from './gui-server.js';

/** Abre o navegador no SO (best effort — falha silenciosa). */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

/**
 * Config: cwd primeiro; se não existir, ao lado do executável.
 * (Duplo clique no Windows nem sempre tem a pasta do exe como cwd.)
 */
function resolveConfigPath(): string {
  if (process.env.HTTPCODER_CONSUMER_CONFIG) return process.env.HTTPCODER_CONSUMER_CONFIG;
  const fromCwd = path.resolve('consumer.config.json');
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.join(path.dirname(process.execPath), 'consumer.config.json');
}

/**
 * Estáticos da GUI: ao lado do executável (caso do binário bun compilado,
 * onde import.meta.url aponta para o FS virtual embutido); no dev (tsx),
 * relativo a este arquivo.
 */
function resolvePublicDir(): string {
  const besideExe = path.join(path.dirname(process.execPath), 'public');
  if (fs.existsSync(path.join(besideExe, 'index.html'))) return besideExe;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
}

async function main(): Promise<void> {
  const configPath = resolveConfigPath();
  const config = loadConfig(configPath);
  // identidade X25519 persistente ao lado do config (TOFU estável entre reinícios)
  const identity = loadOrCreateIdentity(configPath);

  const sandbox = await Sandbox.create({
    allowedPaths: config.allowedPaths,
    allowedCommands: config.allowedCommands,
    commandTimeoutMs: config.commandTimeoutMs,
  });
  const permissions = new PermissionEngine();

  const publicDir = resolvePublicDir();
  if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
    throw new Error(
      `GUI não encontrada em ${publicDir} — extraia o zip completo: a pasta public/ precisa ficar ao lado do executável.`,
    );
  }
  const gui = await createGuiServer({ port: config.guiPort, publicDir });

  const session = new Session({
    serverUrl: config.serverUrl,
    roomCode: config.roomCode,
    fingerprintPin: config.fingerprintPin,
    identity,
  });
  new Bridge({ session, sandbox, permissions, hub: gui, configPath });

  session.on('fingerprint-confirm', ({ fingerprint }: { fingerprint: string }) => {
    console.log('============================================================');
    console.log(`[consumer] fingerprint da sessão: ${fingerprint}`);
    console.log('[consumer] confirme que o host exibe o MESMO fingerprint.');
    console.log('[consumer] confirme ou aborte na GUI; ao confirmar, o pin é gravado no config (TOFU).');
    console.log('============================================================');
  });
  session.on('ready', ({ fingerprint }: { fingerprint: string }) => {
    console.log(`[consumer] conectado ao host. fingerprint da sessão: ${fingerprint}`);
  });
  session.on('fingerprint-mismatch', ({ expected, actual }: { expected: string; actual: string }) => {
    console.error(`[consumer] ALERTA: fingerprint mudou! pin=${expected} atual=${actual}. Conexão abortada.`);
  });
  session.on('error', (err: Error) => {
    console.error(`[consumer] ${err.message}`);
  });

  session.connect();

  const url = `http://127.0.0.1:${gui.port}`;
  console.log(`[consumer] GUI disponível em ${url}`);
  openBrowser(url);
}

main().catch((err) => {
  console.error(`[consumer] erro fatal: ${err instanceof Error ? err.message : err}`);
  // No Windows, segura a janela do console para o usuário ler o erro (duplo clique).
  if (process.platform === 'win32' && process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Pressione Enter para sair...', () => process.exit(1));
  } else {
    process.exit(1);
  }
});
