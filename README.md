# VANTUS • Central de Atendimento

Bot de atendimento automatizado para o servidor FiveM **VANTUS**: fila por ordem de chegada,
atendimentos simultâneos em canais de voz, painel público com atualização automática, painel
exclusivo da equipe, controle administrativo completo e histórico persistente.

> Node.js + discord.js v14 • SQLite local (sem banco externo) • pronto para SquareCloud

---

## Índice

| Documento | Conteúdo |
| --- | --- |
| [docs/01-instalacao-squarecloud.md](docs/01-instalacao-squarecloud.md) | Passo a passo de instalação e deploy |
| [docs/02-configuracao-canais-cargos.md](docs/02-configuracao-canais-cargos.md) | Configuração de canais, cargos e horários |
| [docs/03-permissoes-discord.md](docs/03-permissoes-discord.md) | Permissões e intents do bot |
| [docs/04-guia-jogador.md](docs/04-guia-jogador.md) | Guia para os jogadores |
| [docs/05-guia-staff.md](docs/05-guia-staff.md) | Guia para a equipe de atendimento |
| [docs/06-guia-admin.md](docs/06-guia-admin.md) | Guia administrativo (comandos e configurações) |
| [docs/07-arquitetura.md](docs/07-arquitetura.md) | Arquitetura, modelo de dados e fluxos |
| [docs/08-testes.md](docs/08-testes.md) | Testes automatizados e checklist de QA |

---

## Recursos implementados

**Fila e atendimento**
- Painel público em **Components V2**: card escuro com barra vermelha `#ff2200` (paleta da marca),
  cabeçalho compacto, bloco de status (disponível/indisponível), indicadores em linha, faixa de
  horário e botão **Entrar na fila** à direita — layout clássico em embed por configuração
  (`panel_style`). Painel da equipe no mesmo esquema de cores. Prévias locais em
  `npm run preview` (público + staff).
- Protocolo exclusivo (`#0001`), horário de entrada e posição calculada em tempo real.
- Fila sincronizada com a voz **nos dois sentidos**: entrar na fila move para o canal de espera e
  entrar no canal de espera coloca na fila automaticamente (sair do canal remove da fila).
- **Bloqueio de reentrada**: quem desiste antes de ser chamado fica 10 minutos sem voltar
  (configurável em `rejoin_cooldown_minutes`, liberável com `/fila liberar`).
- Vários staffs atendendo ao mesmo tempo, com controle de concorrência (ninguém pega o mesmo jogador).
- Bloqueio de atendimento duplicado por jogador e por staff (com liberação configurável).
- Perda de presença, desconexão de voz e saída do servidor tratadas automaticamente.

**Painel da equipe**
- Fila completa (posição, nome, protocolo, entrada, espera, status), atendimentos ativos, pendentes,
  staffs e seus estados, espera média, duração média e total do dia.
- Botões: **Chamar próximo**, **Chamar específico** (com motivo obrigatório), **Pular jogador**,
  **Devolver à fila**, **Finalizar**, **Remover da fila** (justificativa obrigatória),
  **Meu status**, **Reativar pendente** e **Atualizar painel**.

**Operação**
- Horário de funcionamento por dia da semana (fuso `America/Sao_Paulo`, janelas que cruzam a madrugada).
- Abertura/fechamento automático pelo horário e manual pela administração.
- Status dos staffs: 🟢 disponível, 🔴 em atendimento, 🟡 ausente, ⚫ indisponível.
- Notificações privadas: entrada, mudança de posição (com anti-spam), chamada, adiamento e avaliação.
- Logs administrativos de todas as ações, com o responsável.
- Estatísticas por hoje/7 dias/30 dias/mês/período total, ranking de produtividade e avaliações.
- Recuperação completa do estado após reinício: fila, atendimentos, painéis e timers.

**Técnico**
- SQLite via `sql.js` (WebAssembly): sem módulo nativo, sem serviço externo, gravação atômica.
- Transações serializadas por mutex → operações críticas atômicas.
- Painéis persistentes: a referência da mensagem fica no banco, nunca duplica.
- Tratamento global de erros, logs estruturados e encerramento gracioso (SIGINT/SIGTERM).
- 52 testes automatizados cobrindo fila, concorrência, voz, painéis, persistência, relatórios e UI.

---

## Início rápido

```bash
git clone <seu-repositorio> && cd avantus
npm install
cp .env.example .env      # preencha DISCORD_TOKEN e GUILD_ID
npm start
```

No Discord, como administrador:

1. `/setup criar_cargos:true` — cria categoria, canais de voz/texto, cargos e publica os painéis.
2. `/diagnostico` — confere canais, permissões e painéis.
3. `/central abrir` — abre a central fora do horário programado (opcional).
4. `/horario ver` — revisa a agenda de atendimento.

Guia completo: [docs/01-instalacao-squarecloud.md](docs/01-instalacao-squarecloud.md).

---

## Estrutura do projeto

```
index.js                  ponto de entrada (SquareCloud: MAIN=index.js)
squarecloud.app           configuração de deploy
.env.example              variáveis de ambiente
src/
  commands/
    admin/                painel, central, config, horario, staff, fila, estatisticas,
                          avaliacoes, historico, diagnostico, setup
    staff/                chamar, finalizar, devolver, pular, status
    player/               entrar, sair, posicao, protocolo, ajuda
  config/                 env, settings (editáveis), permissions, theme
  database/
    connection.js         SQLite (sql.js), transações e persistência atômica
    migrations.js         schema versionado
    repositories/         settings, attendance, staff, evaluations, audit, panels, counters
  systems/
    queue/                fachada da fila
    attendance/           motor de atendimento (regras, timers, recuperação)
    staff/                disponibilidade da equipe
    statistics/           relatórios e ranking
    evaluations/          avaliações pós-atendimento
    notifications/        mensagens privadas e avisos
    logs/                 auditoria (banco + canal de logs)
    schedule/             horário de funcionamento e abertura/fechamento
    panels/               publicação/atualização dos painéis
    recovery/             recuperação pós-reinício e diagnóstico
  dashboard/
    panels/               layout dos painéis público e staff
    embeds/               cards e mensagens
    components/           botões, selects e IDs persistentes
  interactions/           routers, botões, selects e modais
  events/                 client, members, voice
  handlers/               carregamento de comandos/eventos, respostas, registro
  services/               gateway do Discord, container de dependências, erros
  utils/                  logger, tempo/fuso, validadores
scripts/                  deploy de comandos, checagem de sintaxe e de arquivos versionados
tests/                    testes automatizados (node:test)
docs/                     guias de instalação, uso e arquitetura
data/                     banco SQLite (apenas .gitkeep é versionado)
.github/workflows/        CI (lint + testes + checagem de versionamento)
```

### Convenções do repositório

- Nenhum arquivo de configuração sensível é versionado (`.env`, `data/*.sqlite`).
- `npm run check:tracked` falha se algum arquivo-fonte estiver fora do Git — proteção contra
  regras de `.gitignore` que capturem pastas do código (ex.: `src/systems/logs`).
- Padrões de exclusão do armazenamento ficam em `squarecloud.ignore`; os do Git em `.gitignore`.
- Fim de linha LF e Node 22 fixados em `.gitattributes` e `.nvmrc`.

---

## Comandos

| Categoria | Comando | Descrição |
| --- | --- | --- |
| Jogador | `/entrar` | Entra na fila |
| Jogador | `/sair` | Sai da fila |
| Jogador | `/posicao` | Mostra posição e previsão |
| Jogador | `/protocolo [numero]` | Consulta seu protocolo |
| Jogador | `/ajuda` | Como funciona o atendimento |
| Staff | `/chamar [jogador] [motivo]` | Chama o próximo ou um jogador específico |
| Staff | `/finalizar [observacao]` | Encerra seu atendimento |
| Staff | `/devolver [motivo]` | Devolve o jogador ao final da fila |
| Staff | `/pular jogador motivo` | Pula um jogador (motivo obrigatório) |
| Staff | `/status situacao` | Define sua disponibilidade |
| Admin | `/painel publicar\|atualizar\|reconstruir` | Gerencia os painéis |
| Admin | `/central abrir\|fechar\|alternar\|status` | Controla a central |
| Admin | `/config ver\|definir` | Edita qualquer configuração |
| Admin | `/horario ver\|definir\|fechar_dia\|modelo` | Agenda de funcionamento |
| Admin | `/staff lista\|status` | Disponibilidade da equipe |
| Admin | `/fila ver\|pular\|remover\|reativar\|liberar\|limpar` | Administra a fila |
| Admin | `/estatisticas [periodo]` | Relatórios e ranking |
| Admin | `/avaliacoes [periodo]` | Avaliações recebidas |
| Admin | `/historico protocolo\|jogador\|ultimos` | Histórico completo |
| Admin | `/diagnostico` | Checagem de configuração |
| Admin | `/setup [criar_cargos]` | Cria a estrutura e publica os painéis |

---

## Scripts

```bash
npm start                 # inicia o bot
npm test                  # roda os 76 testes
npm run lint              # checagem de sintaxe de todo o projeto
npm run check:tracked     # garante que nenhum arquivo-fonte ficou fora do Git
npm run deploy:commands   # registra os slash commands manualmente
npm run package           # gera o .zip de deploy para a SquareCloud
npm run preview           # gera preview/panel.html e preview/staff.html (layout e cores reais)
```

O pacote gerado (`entrega/vantus-atendimento-squarecloud.zip`) já sai sem `node_modules`, `tests`,
`data`, `.env` ou arquivos SQLite, com o `squarecloud.app` na raiz. Uma versão pronta para download
fica em [`entrega/`](entrega/).

## Licença

Uso interno do servidor VANTUS. Todos os direitos reservados.
