# 01 • Instalação e deploy na SquareCloud

## 1. Pré-requisitos

- Conta na [SquareCloud](https://squarecloud.app) com um plano ativo.
- Bot criado no [Discord Developer Portal](https://discord.com/developers/applications).
- Node.js 20+ apenas para rodar/testar localmente.

## 2. Criar a aplicação no Discord

1. Developer Portal → **New Application** → aba **Bot** → **Reset Token** (guarde o token).

> **Bot atual da VANTUS:** Application ID `1200967871480737912`.
> O token desse bot vai no `.env` (nunca no chat/git) — veja a seção **Troca de bot** no fim.
2. Ainda em **Bot**, ative:
   - **SERVER MEMBERS INTENT** (obrigatório — o bot precisa ver cargos e entradas/saídas)
   - *Message Content* **não** é necessário.
3. Em **Installation** → **Guild Install** → scopes `bot` e `applications.commands`.
4. Permissões mínimas (veja [03-permissoes-discord.md](03-permissoes-discord.md)):

```
https://discord.com/api/oauth2/authorize?client_id=1200967871480737912&permissions=286346256&scope=bot%20applications.commands
```

Para gerar o link de outra aplicação (ou confirmar as permissões):

```bash
npm run invite                          # usa o CLIENT_ID do .env
npm run invite -- 1200967871480737912   # ou informe direto
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
CLIENT_ID=1200967871480737912
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
npm test      # 166 testes, nenhum token necessário
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
- No repositório, a pasta `data/` contém apenas um `.gitkeep`; o banco nunca é versionado.

## 7. Primeiro uso no Discord

Como administrador do servidor:

```
/setup criar_cargos:true
/diagnostico
/central status
/horario ver
```

O `/setup` cria:

- Categoria **🎧・central de atendimento**
- Voz **⏳・aguardando-atendimento**, **🔉・suporte¹**, **🔉・suporte²**, **🔉・suporte³**
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
| `Missing Access` (50001) ao registrar comandos | o bot do token **não está** no servidor do `GUILD_ID` | convide com `npm run invite` (o log do boot mostra o link com a aplicação certa) e reinicie |
| Conectou com um nome/ID de bot diferente do esperado | token de outra aplicação | o log mostra `aplicação <id>`; gere o token da aplicação correta |
| `Used disallowed intents` | intent não ativada | ative **Server Members** no portal |
| Comandos não aparecem | registro falhou | `npm run deploy:commands` ou reinicie |
| Bot não move jogadores | sem **Mover membros** | revise [03-permissoes-discord.md](03-permissoes-discord.md) |
| Fila não abre | horário fechado | `/central abrir` ou `/horario definir` |

## 9.1 Deploy automático (API / CI)

Além do upload manual no painel, o pacote pode ser publicado pela API oficial.

**No seu computador:**

```bash
SQUARECLOUD_TOKEN=xxxx SQUARECLOUD_APP_ID=yyyy npm run deploy:squarecloud
```

- `SQUARECLOUD_TOKEN`: squarecloud.app → **Conta → Segurança** → novo token com os escopos
  `apps:deploy`, `apps:control` e (opcional) `files:write`.
- `SQUARECLOUD_APP_ID`: o ID da aplicação (aparece na URL do painel).
- Opções: `--reset-data` (apaga `data/vantus.sqlite` antes do envio), `--no-restart`,
  `--dry-run`, `--keep-package`.

**Automático a cada merge na `main`:** o workflow `.github/workflows/deploy-squarecloud.yml`
faz isso sozinho. Cadastre em **GitHub → Settings → Secrets and variables → Actions**:

| Secret | Valor |
| --- | --- |
| `SQUARECLOUD_TOKEN` | token da API (nunca no código) |
| `SQUARECLOUD_APP_ID` | ID da aplicação |

Depois disso, todo push na `main` gera o pacote, publica e reinicia. Também dá para rodar
à mão em **Actions → Deploy SquareCloud → Run workflow**, marcando *reset_data* para começar
com banco limpo.

> **Integração via GitHub do painel:** ela publica o repositório inteiro (rodando `npm install`
> e `node index.js`), respeitando o `squarecloud.ignore`. Se a integração estiver apontando para
> uma branch antiga, o painel sobe código velho — troque para **`main`** em *Integrações →
> GitHub*, ou use o workflow acima, que sempre publica o pacote da `main`.

## 10. Troca de bot (nova aplicação)

Ao migrar para outra aplicação do Discord (outro Application ID/token):

1. **Developer Portal (aplicação nova) → Bot → Reset Token** e copie o token.
2. No `.env` (ou nas variáveis da SquareCloud), troque:
   ```env
   DISCORD_TOKEN=token_do_bot_novo
   CLIENT_ID=1200967871480737912
   ```
3. Convide o bot novo no servidor: `npm run invite` (usa o `CLIENT_ID`) ou
   `npm run invite -- 1200967871480737912`.
4. Confira permissões no servidor: o bot precisa gerenciar canais/cargos e mover membros.
5. **Remova o bot antigo** do servidor para os dois não disputarem os mesmos painéis.
6. Reinicie o bot e rode `/setup` (recria/renomeia canais e publica os painéis) e
   `npm run deploy:commands` se os comandos não aparecerem.
7. `/diagnostico` mostra o **bot conectado** e avisa se o token é de um bot diferente do
   `CLIENT_ID` — assim uma troca pela metade não passa batido.

O log do boot sempre informa a aplicação do token:

```text
[ready] Conectado como VANTUS ATENDIMENTO#8206 (aplicação 1565771323492536520, 1 servidor(es))
[ready] O bot VANTUS ATENDIMENTO#8206 não está no servidor configurado (4402...).
        Servidores atuais: Outro servidor (9999...).
        Convide com: https://discord.com/api/oauth2/authorize?client_id=1565771323492536520&...
```

Se o bot não estiver no servidor, o VANTUS **não tenta registrar comandos** (era daí que vinha o
`Missing Access`) e sobe a central sozinho assim que o convite for aceito — sem reiniciar.

**Servidor salvo que não existe mais** (banco de teste, servidor antigo, bot removido do servidor):
o boot passa a **adotar o `GUILD_ID` (ou `DEV_GUILD_ID`) do ambiente** e corrige o `guild_id` no
banco automaticamente:

```text
[ready] Servidor salvo (440265886302076928) não está disponível para o bot;
        usando 1200967871480737912 de GUILD_ID. Configuração do banco atualizada.
```

Assim não é mais preciso apagar o banco nem usar `DEV_GUILD_ID` para trocar de servidor.

> O `data/vantus.sqlite` (escala, horas, configurações) continua o mesmo: a troca de bot não
> afeta os dados. As mensagens dos painéis antigos são substituídas na republicação.

## Painel web do banco de horas (opcional)

O painel sobe junto com o bot e permite cadastrar a escala da equipe e ver as horas trabalhadas.

1. No `.env`, defina `WEB_PANEL_PASSWORD` com uma senha forte.
2. Localmente, acesse `http://localhost:8080`.
3. Na SquareCloud, o painel é exposto como site: mantenha o app do tipo **Site** e use
   `WEB_PANEL_PORT=80`. Se não quiser expor nada, deixe `WEB_PANEL_PASSWORD` vazio.
4. Guia completo: [09-banco-de-horas.md](09-banco-de-horas.md).
