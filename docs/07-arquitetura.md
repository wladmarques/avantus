# 07 • Arquitetura

## Visão geral

```
Discord  ──►  events/ (client, voice, members)
                  │
                  ▼
        interactions/router  ──►  commands/ (admin, staff, player)
                  │                    │
                  ▼                    ▼
        ┌───────────────────── services/ (container) ─────────────────────┐
        │  systems/attendance  ◄──  systems/queue  ◄──  systems/staff      │
        │        │                    │                   │               │
        │        ├──► systems/schedule (horário)          │               │
        │        ├──► systems/panels   (painéis)          │               │
        │        ├──► systems/notifications (DMs)         │               │
        │        ├──► systems/logs (auditoria)            │               │
        │        └──► services/discordGateway ◄───────────┘               │
        └────────────────────────────┬────────────────────────────────────┘
                                     ▼
                     database/ (sql.js + transactions) ──► data/vantus.sqlite
```

O domínio conhece apenas o **gateway** (`getMember`, `moveToVoiceChannel`, `grantVoiceAccess`,
`sendDirectMessage`...). Nos testes, um `MemoryGateway` substitui o Discord inteiro — por isso as
regras de fila/atendimento são testáveis sem token.

## Modelo de dados

| Tabela | Conteúdo |
| --- | --- |
| `settings` | configurações editáveis (JSON por chave) |
| `counters` | sequência de protocolos e ordem da fila |
| `attendance` | protocolo, jogador, staff, tempos, status, resultado, overrides |
| `staff_status` | disponibilidade por membro (`manual` = definido pelo próprio staff) |
| `evaluations` | nota vinculada ao protocolo e ao staff (única por atendimento) |
| `audit_events` | histórico imutável de ações (tipo, autor, alvo, protocolo, mensagem) |
| `panels` | canal + mensagem de cada painel (evita duplicidade) |
| `schema_migrations` | versão do schema aplicada |

### Status de um registro

```
waiting ──► serving ──► finished
   │           │
   ├──► hold ──┘        (pulado / pendente)
   └──► finished        (desistiu, removido, cancelado…)
```

Índices garantem invariantes:
- `ux_attendance_active_user` → um jogador nunca tem dois registros ativos;
- `ux_attendance_protocol` → protocolo único por servidor.

## Atomicidade e concorrência

1. Toda escrita passa por `db.transaction()`, que usa um **mutex** e `BEGIN IMMEDIATE … COMMIT`.
2. Operações que dependem de leitura + escrita (reservar jogador, criar protocolo) acontecem
   **dentro** da mesma transação.
3. A chamada revalida o estado dentro da transação e, se outro staff pegou o jogador primeiro,
   tenta novamente com o próximo da fila.
4. A regra “um atendimento por staff” é validada no serviço (liberável por `allow_staff_multi`).
5. Falha em qualquer etapa → `ROLLBACK` e nada é persistido.

## Persistência

- SQLite compilado para WebAssembly (`sql.js`): nenhuma dependência nativa, funciona em qualquer
  runtime Node ≥ 20 da SquareCloud.
- `export()` → arquivo temporário → `fsync` → `rename` (gravação atômica).
- Backup automático em `*.sqlite.bak` a cada 5 minutos.
- Ao abrir, o banco é validado; se estiver corrompido, o backup é usado.

## Ciclo de vida

**Start**
1. `.env` validado.
2. Banco aberto + migrações aplicadas.
3. Serviços montados, comandos/eventos carregados.
4. `ready`: comandos registrados → `RecoveryService.run()`.
5. Timers: painéis (`panel_refresh_seconds`), expiração de fila (60s), watcher de horário (30s).

**Recuperação (`RecoveryService`)**
- quem saiu do servidor durante o downtime é encerrado;
- atendimentos cujo staff sumiu são encerrados e o jogador volta à fila;
- staff preso em EM ATENDIMENTO é liberado;
- jogadores são reposicionados no canal de espera;
- painéis são editados (ou marcados para reconstrução).

**Shutdown**
- `SIGINT`/`SIGTERM`: limpa timers, fecha o client, persiste o banco e sai com código 0.

## Timeouts e eventos

| Origem | Reação |
| --- | --- |
| Jogador entra no canal de atendimento | presença confirmada, timer cancelado |
| Jogador não entra no prazo | **NÃO COMPARECEU** → volta à fila ou encerra (`no_show_policy`) |
| Jogador sai do canal durante o atendimento | tolerância → **DESCONECTOU** |
| Staff sai do canal | status INDISPONÍVEL, tolerância → **STAFF DESCONECTOU** + jogador volta à fila |
| Jogador sai do servidor | encerra registro e libera vaga |
| Staff sai do servidor | encerra atendimento e marca INDISPONÍVEL |
| Tempo máximo de espera | remove da fila com log e DM |

## Painéis

- Layout em `dashboard/panels/*` (JSON puro, sem client) → testável.
- IDs dos componentes são **fixos e persistentes** (`pub:join`, `staff:call_next`...), então botões
  continuam funcionando depois de reinícios.
- Atualização: debounce de 1,2s nas mudanças + refresh periódico para os contadores de tempo.

## Tratamento de erros

- `AppError` carrega `userMessage`: sempre há resposta clara ao usuário.
- Erros inesperados são logados e, no máximo a cada 30s, enviados ao canal de logs.
- Handlers globais: `unhandledRejection` e `uncaughtException` não derrubam o processo;
  `AUTORESTART=true` cobre falhas reais.
