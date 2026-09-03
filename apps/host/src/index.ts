import { createInterface } from 'node:readline/promises';
import { loadConfig, resolveConfigPath, saveFingerprintPin } from './config.js';
import { OllamaClient } from './ollama.js';
import { HostSession } from './session.js';
import { AgentLoop } from './agent.js';
import { loadOrCreateIdentity } from './identity.js';
import { checkHardwareAndModel } from './hardware.js';

/** Pergunta interativa de confirmação do fingerprint (TOFU) no console. */
async function confirmFingerprint(fp: string): Promise<boolean> {
  console.log('');
  console.log('Primeira conexão com este consumer. Fingerprint da sessão:');
  console.log(`  ${fp}`);
  console.log('Confirme no consumer (terminal ou GUI) que o fingerprint é o MESMO antes de prosseguir.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Os fingerprints batem? [s/N] ');
    return answer.trim().toLowerCase() === 's';
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const configPath = resolveConfigPath();
  const config = loadConfig(configPath);
  console.log(`[host] config carregado de ${configPath}`);
  console.log(`[host] relay: ${config.serverUrl} | ollama: ${config.ollamaUrl} | modelo: ${config.defaultModel}`);

  const ollama = new OllamaClient(config.ollamaUrl);

  // Detecta GPU/sugere modelo antes de conectar; nunca derruba o boot.
  await checkHardwareAndModel({ ollama, defaultModel: config.defaultModel });

  // Identidade persistente: fingerprint estável entre reinícios (TOFU).
  const identity = loadOrCreateIdentity(configPath);

  const session = new HostSession(
    {
      serverUrl: config.serverUrl,
      roomCode: config.roomCode,
      identity,
      fingerprintPin: config.fingerprintPin,
      confirmFingerprint,
      savePin: (pin) => {
        saveFingerprintPin(configPath, pin);
        console.log('[host] fingerprint fixado no config (TOFU)');
      },
    },
    {
      onMessage: (msg) => {
        void agent.handleMessage(msg).catch((err: unknown) => {
          console.error('[host] erro no loop agêntico:', err);
        });
      },
      onLog: (msg) => console.log(`[host] ${msg}`),
      onEstablished: (fp) => console.log(`[host] sessão estabelecida (fingerprint ${fp})`),
      onDisconnected: () => console.log('[host] consumer/relay desconectou'),
      onFatal: (err) => {
        console.error(`[host] ERRO FATAL: ${err.message}`);
        process.exitCode = 1;
      },
    },
  );

  const agent = new AgentLoop({ ollama, defaultModel: config.defaultModel, session });

  await session.connect();
}

main().catch((err: unknown) => {
  console.error('[host] falha ao iniciar:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
