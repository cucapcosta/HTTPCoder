import { exec } from 'node:child_process';
import path from 'node:path';
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

async function main(): Promise<void> {
  const configPath = process.env.HTTPCODER_CONSUMER_CONFIG ?? './consumer.config.json';
  const config = loadConfig(configPath);
  // identidade X25519 persistente ao lado do config (TOFU estável entre reinícios)
  const identity = loadOrCreateIdentity(configPath);

  const sandbox = await Sandbox.create({
    allowedPaths: config.allowedPaths,
    allowedCommands: config.allowedCommands,
    commandTimeoutMs: config.commandTimeoutMs,
  });
  const permissions = new PermissionEngine();

  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const gui = await createGuiServer({ port: config.guiPort, publicDir });

  const session = new Session({
    serverUrl: config.serverUrl,
    roomCode: config.roomCode,
    fingerprintPin: config.fingerprintPin,
    identity,
  });
  new Bridge({ session, sandbox, permissions, hub: gui });

  session.on('ready', ({ fingerprint }: { fingerprint: string }) => {
    console.log(`[consumer] conectado ao host. fingerprint da sessão: ${fingerprint}`);
    if (!config.fingerprintPin) {
      console.log('[consumer] primeira conexão: confira o fingerprint com o host e fixe "fingerprintPin" no config (TOFU).');
    }
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
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
