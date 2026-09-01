# Deploy do apps/server (relay WebSocket) no Railway.
#
# Dockerfile em vez de Nixpacks porque:
#  1. o start roda TS direto via `tsx`, que é devDependency do root — o Nixpacks
#     faz `npm prune --omit=dev` na imagem final e o start quebraria;
#  2. npm workspaces + Nixpacks costuma exigir ajustes extras; aqui o build é
#     determinístico (`npm install` na raiz resolve os workspaces).
#
# Contexto de build: raiz do monorepo. O Railway detecta este Dockerfile
# automaticamente e injeta a variável PORT em runtime.

FROM node:26-slim

WORKDIR /app

# Manifests de TODOS os workspaces: o `npm install` na raiz resolve o monorepo
# inteiro e valida o package-lock.json — faltar qualquer package.json quebra o install.
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/host/package.json apps/host/package.json
COPY apps/consumer/package.json apps/consumer/package.json
COPY packages/protocol/package.json packages/protocol/package.json

# Install completo (sem --omit=dev: o start usa tsx, que é devDependency).
# Dependências de host/consumer entram na imagem, mas o código deles não — ver .dockerignore.
RUN npm install

# Código-fonte apenas do server e do protocolo compartilhado
COPY apps/server ./apps/server
COPY packages/protocol ./packages/protocol

CMD ["npm", "run", "start", "-w", "apps/server"]
