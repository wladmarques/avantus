# 01 • Instalação e deploy na SquareCloud

## 1. Pré-requisitos

- Conta na [SquareCloud](https://squarecloud.app) com um plano ativo.
- Bot criado no [Discord Developer Portal](https://discord.com/developers/applications).
- Node.js 20+ apenas para rodar/testar localmente.

## 2. Criar a aplicação no Discord

1. Developer Portal → **New Application** → aba **Bot** → **Reset Token** (guarde o token).
2. Ainda em **Bot**, ative:
   - **SERVER MEMBERS INTENT** (obrigatório — o bot precisa ver cargos e entradas/saídas)
   - *Message Content* **não** é necessário.
3. Em **Installation** → **Guild Install** → scopes `bot` e `applications.commands`.
4. Permissões mínimas (veja [03-permissoes-discord.md](03-permissoes-discord.md)):

```
https://discord.com/api/oauth2/authorize?client_id=SEU_CLIENT_ID&permissions=286346256&scope=bot%20applications.commands
```

5. Copie o **Application ID** (Client ID) e o **GUILD_ID** do servidor
   (clique com o botão direito no ícone do servidor → *Copiar ID*, com o Modo Desenvolvedor ativo).

## 3. Preparar o projeto

```bash
npm install
cp .env.example .env
```

Edite o `.env`:

```env
DISCORD_TOKEN=seu_token_aqui
GUILD_ID=123456789012345678
DB_PATH=./data/vantus.sqlite
TIMEZONE=America/Sao_Paulo
AUTO_REGISTER_COMMANDS=true
PANEL_REFRESH_SECONDS=30
LOG_LEVEL=info
```

> **Nunca** comite o `.env`. Ele já está no `.gitignore`.

Teste localmente:

```bash
npm test      # 52 testes, nenhum token necessário
npm start     # conecta o bot
```

## 4. Configurar o `squarecloud.app`

O arquivo já está pronto no repositório:

```env
MAIN=index.js
MEMORY=512
VERSION=recommended
DISPLAY_NAME=VANTUS Atendimento
DESCRIPTION=Central de atendimento automatizada com fila por voz para o servidor VANTUS
AUTORESTART=true
```

- `MEMORY=512` é suficiente para o bot; aumente para 1024 se o servidor tiver muitos atendimentos simultâneos.
- `AUTORESTART=true` mantém o bot online após falhas transitórias.
- Não use `SUBDOMAIN`: bots não precisam de publicação web.

## 5. Publicar na SquareCloud

**Pelo dashboard**

1. **Nova aplicação** → envie o projeto em `.zip`
   (inclua `index.js`, `src/`, `package.json`, `squarecloud.app`; **exclua** `node_modules/`, `.git/`, `.env` e `data/`).
2. Em **Variáveis de ambiente**, cadastre as mesmas chaves do `.env`
   (`DISCORD_TOKEN`, `GUILD_ID`, `DB_PATH=./data/vantus.sqlite`, `TIMEZONE`, `AUTO_REGISTER_COMMANDS`, `LOG_LEVEL`).
   O uso do `.env` dentro do zip também funciona, mas variáveis no painel são mais seguras.
3. **Iniciar aplicação** e acompanhe os logs.

**Pela CLI**

```bash
npx squarecloud-cli auth                  # autentica com a API key
npx squarecloud-cli deploy .              # envia o projeto
npx squarecloud-cli logs <app-id> --tail  # acompanha os logs
```

## 6. Persistência de dados

- O banco fica em `DB_PATH` (padrão `./data/vantus.sqlite`), **dentro do armazenamento da aplicação** na SquareCloud.
- A gravação é atômica (`arquivo.tmp` → `fsync` → rename) e há backup automático em `arquivo.sqlite.bak`.
- Arquivos da aplicação persistem entre reinícios e atualizações, mas **um novo deploy substitui o código**:
  mantenha a pasta `data/` fora do pacote enviado para não sobrescrever o banco.
- Recomendado: crie snapshots manuais no painel antes de grandes atualizações.
- Para baixar o banco: use o gerenciador de arquivos da SquareCloud e copie `data/vantus.sqlite`.

## 7. Primeiro uso no Discord

Como administrador do servidor:

```
/setup criar_cargos:true
/diagnostico
/central status
/horario ver
```

O `/setup` cria:

- Categoria **CENTRAL DE ATENDIMENTO**
- Voz **AGUARDANDO ATENDIMENTO**, **ATENDIMENTO 01**, **ATENDIMENTO 02**, **ATENDIMENTO 03**
- Texto **central-atendimento** (painel público), **painel-staff**, **logs-atendimento**
- Cargos **Staff VANTUS** e **Admin VANTUS** (opcional)
- Publica os dois painéis e salva todos os IDs

## 8. Atualizações

1. Faça backup (`data/` + snapshot no painel).
2. Envie o novo pacote mantendo a pasta `data/`.
3. As migrações de banco rodam sozinhas no start (`src/database/migrations.js`).
4. Rode `/painel publicar painel:Ambos` se alterou textos/configurações visuais.

## 9. Problemas comuns

| Sintoma | Causa provável | Solução |
| --- | --- | --- |
| `DISCORD_TOKEN não configurado` | variável ausente | preencha no painel/.env |
| Bot offline, sem erro | token inválido | gere novo token e atualize |
| `Used disallowed intents` | intent não ativada | ative **Server Members** no portal |
| Comandos não aparecem | registro falhou | `npm run deploy:commands` ou reinicie |
| Bot não move jogadores | sem **Mover membros** | revise [03-permissoes-discord.md](03-permissoes-discord.md) |
| Fila não abre | horário fechado | `/central abrir` ou `/horario definir` |
