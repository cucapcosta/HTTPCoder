# Deploy e release

Passo a passo para publicar os binários (GitHub Releases) e subir o servidor relay
(Railway). Componentes: ver `peridocs/specs/2026-09-01-ia-local-distribuida-design.md`.

- **apps/server** — relay WebSocket, deploy contínuo no Railway via `Dockerfile` na raiz.
- **apps/host** — CLI compilada para Linux e Windows (GitHub Actions + `bun build --compile`).
- **apps/consumer** — CLI Windows, distribuída em `.zip` com o `.exe` + estáticos da web GUI.

## 1. Release dos binários (GitHub Actions)

O workflow `.github/workflows/release.yml` dispara em push de tag `v*` (ou manualmente
em *Actions → Release → Run workflow*, informando a tag).

Primeira release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

A pipeline compila com `bun build --compile` e anexa ao Release da tag:

| Asset | Alvo | Conteúdo |
|---|---|---|
| `httpcoder-host-linux-x64` | `bun-linux-x64` | binário único |
| `httpcoder-host-windows-x64.exe` | `bun-windows-x64` | binário único |
| `httpcoder-consumer-windows-x64.zip` | `bun-windows-x64` | `.exe` + pasta `public/` (index.html, app.js) |

Os nomes são estáveis entre versões: só muda a tag na URL. O consumer é zipado porque
`bun build --compile` não embute arquivos soltos — o binário deve servir os estáticos
da pasta `public/` **ao lado do executável** (resolver o caminho relativo ao diretório
do `.exe`, não ao CWD).

## 2. Deploy do servidor no Railway

O servidor é deployado com o `Dockerfile` da raiz (o Railway detecta automaticamente).
Escolhemos Dockerfile em vez de Nixpacks porque o start roda TS via `tsx`
(devDependency) e o Nixpacks remove devDependencies na imagem final.

Passos:

1. *New Project → Deploy from GitHub repo* e selecione este repositório (raiz do monorepo).
2. Em **Variables**, configure:

   | Variável | Valor |
   |---|---|
   | `HOST_ASSET_URL` | URL do asset do host no GitHub Releases (ver abaixo) |
   | `CONSUMER_ASSET_URL` | URL do asset do consumer |
   | `PORT` | **não definir** — o Railway injeta automaticamente; o server deve escutar em `process.env.PORT` |

   Recomendado: usar as URLs `latest`, que não mudam entre releases:

   ```
   https://github.com/<dono>/<repo>/releases/latest/download/httpcoder-host-windows-x64.exe
   https://github.com/<dono>/<repo>/releases/latest/download/httpcoder-consumer-windows-x64.zip
   ```

   Assim `GET /download/host` e `GET /download/consumer` sempre redirecionam para a
   versão mais recente, sem editar as envs a cada tag.

3. (Opcional) Em **Settings → Healthcheck**, aponte para `GET /health`.

## 3. Configuração dos clients

Os arquivos de config ficam ao lado do executável de cada client. **Atenção:** os apps
ainda estão em implementação — os campos abaixo derivam do design (seções 5–8 do spec)
e devem ser conferidos contra o código quando ele existir.

### `host.config.json`

| Campo | Descrição |
|---|---|
| `serverUrl` | WebSocket do relay, ex. `wss://<app>.up.railway.app/ws` |
| `roomCode` | Código da sala (8+ caracteres); igual no host e no consumer |
| `ollamaUrl` | API do Ollama local (default `http://localhost:11434`) |
| `model` | Modelo default usado quando o consumer não escolhe outro |
| `fingerprint` | Pin TOFU do fingerprint da sessão; preenchido na 1ª conexão confirmada, alerta se mudar |

### `consumer.config.json`

| Campo | Descrição |
|---|---|
| `serverUrl` | Mesmo `serverUrl` do host |
| `roomCode` | Mesmo código de sala do host |
| `port` | Porta da web GUI local (localhost); troque se estiver bloqueada/ocupada |
| `allowedPaths` | Pastas onde o agente pode ler/escrever arquivos (sandbox) |
| `allowedCommands` | Allowlist de comandos executáveis (ex. `git status`, `npm test`) |
| `fingerprint` | Pin TOFU, mesmo esquema do host |

## 4. Pendências do primeiro run real

- Os apps ainda não têm `src/index.ts` — o workflow falha até que host e consumer
  existam. Idem `apps/consumer/web/main.tsx` (build:web) e `public/index.html`.
- O workflow usa `bun install` (gera `bun.lock` na CI); a resolução pode divergir
  levemente do `package-lock.json`. Se for problema, commitar o `bun.lock`.
- Conferir se o server lê `process.env.PORT` (o Railway injeta; sem isso o deploy não sobe).
- Validar no Windows real que o consumer encontra `public/` relativo ao `.exe`.
