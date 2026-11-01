# 02 • Configuração de canais, cargos e horários

Tudo é editável em tempo de execução — sem alterar código. Use `/config ver` para inspecionar
e `/config definir` para alterar. As chaves abaixo são as mesmas usadas no banco.

## Canais e categoria

| Chave | Descrição | Exemplo |
| --- | --- | --- |
| `guild_id` | ID do servidor da VANTUS | `123456789012345678` |
| `public_channel_id` | Canal de texto do painel público | `300000000000000001` |
| `staff_channel_id` | Canal de texto do painel da staff | `300000000000000002` |
| `log_channel_id` | Canal de logs administrativos | `300000000000000003` |
| `category_id` | Categoria CENTRAL DE ATENDIMENTO | `400000000000000001` |
| `wait_channel_id` | Canal de voz AGUARDANDO ATENDIMENTO | `200000000000000001` |
| `attendance_channel_ids` | Canais de voz de atendimento | `["200...002","200...003"]` |

```bash
/config definir chave:attendance_channel_ids valor:["200000000000000002","200000000000000003","200000000000000004"]
```

> Canais de voz dentro da categoria configurada também são aceitos como canais de atendimento
> (validação por `parentId`), mas o ideal é listar os IDs explicitamente.

## Cargos

| Chave | Descrição |
| --- | --- |
| `staff_role_ids` | Cargos que podem usar o painel da staff |
| `admin_role_ids` | Cargos administrativos (configurações, fechamento, remoções) |

```bash
/config definir chave:staff_role_ids valor:["111111111111111111"]
/config definir chave:admin_role_ids valor:["222222222222222222"]
```

Administradores do servidor e o dono **sempre** têm acesso, independente dos cargos.

## Horário de funcionamento

Modelo padrão aplicado em `/horario modelo`:

| Dia | Janela |
| --- | --- |
| Segunda a sexta | 12:00 às 02:00 (cruza a madrugada) |
| Sábado e domingo | 12:00 às 00:00 |

```bash
/horario definir dia:Sexta abertura:12:00 fechamento:02:00
/horario fechar_dia dia:Segunda
/horario ver
```

Regras:

- Fuso fixo `America/Sao_Paulo` (configurável por `TIMEZONE`).
- `fechamento` menor que `abertura` = janela que atravessa a madrugada (ex.: 12:00 → 02:00).
- Fora da janela a central fica **FECHADA**: novas entradas são bloqueadas, atendimentos em andamento continuam.
- `central_manual` (`auto` | `open` | `closed`) sobrepõe a agenda. Use `/central abrir|fechar` ou
  `/config definir chave:central_manual valor:auto` para voltar ao automático.

## Fila e canal de voz (sincronizados nos dois sentidos)

| Ação do jogador | O que o bot faz |
| --- | --- |
| Clica em **Entrar na fila** (painel/comando) | registra o protocolo e **move para o canal de espera** (só com staff disponível e central aberta) |
| **Entra no canal de espera** | **entra na fila automaticamente** (gera protocolo e envia DM) |
| Sai do canal de espera | **sai da fila na hora** (desistência) e recebe **bloqueio de 10 min** |
| É chamado por um staff | vai para o canal de atendimento e a presença é confirmada |

```bash
/config definir chave:auto_queue_on_voice_join valor:false   # exige o clique no painel
```

> O bot nunca move alguém para um canal sem a pessoa estar conectada em voz: se o jogador
> clicar em **Entrar na fila** sem estar em nenhum canal, ele recebe a instrução no privado para
> entrar em **AGUARDANDO ATENDIMENTO** (e entra na fila assim que entrar no canal).

### Quando a entrada na fila é liberada

Só é possível entrar na fila quando **as duas condições** são verdadeiras:

1. a central está **dentro do horário** de atendimento (ou aberta manualmente com `/central abrir`);
2. existe **pelo menos um staff com status DISPONÍVEL**.

Enquanto faltar uma delas:

- o botão **Entrar na Fila** do painel fica **desabilitado** (e o rodapé mostra o motivo:
  *sem staff em serviço* ou *central fechada • reabre …*);
- `/entrar`, o clique no botão e a entrada pelo canal de voz são recusados com mensagem explicando
  o motivo;
- quem já está na fila **continua** nela — a regra vale apenas para novas entradas.

O staff fica disponível com `/staff status` → **Disponível** ou entrando em um canal de atendimento,
e o painel é atualizado na hora (o botão volta a funcionar na mesma hora).

### Saída do canal de espera (regra fixa)

Sair do canal **AGUARDANDO ATENDIMENTO** remove o jogador da fila imediatamente — não existe
configuração para manter alguém na fila fora do canal. Vale para:

- desconexão voluntária, quedas de conexão e remoções feitas pela moderação;
- mudança para qualquer outro canal de voz (inclusive o de atendimento antes de ser chamado).

A saída encerra o protocolo como **JOGADOR DESISTIU**, envia DM ao jogador e aplica o bloqueio de
reentrada (`rejoin_cooldown_minutes`). O evento fica registrado como `QUEUE_LEFT_WAIT_VOICE`.

### O jogador entrou no canal de espera e não entrou na fila

A entrada automática só acontece quando **todas** as condições abaixo são verdadeiras. O bot
registra o motivo no log (`[voz] …`) e o `/diagnostico` mostra o estado de cada uma:

| Condição | Como conferir / corrigir |
| --- | --- |
| `wait_channel_id` aponta para o canal **AGUARDANDO ATENDIMENTO** | `/diagnostico` → *Canal de espera*; refaça com `/setup` se o canal foi recriado |
| O jogador entrou **nesse** canal (não em outro de voz) | log `[voz] … entrou no canal X; canal de espera configurado: Y` |
| `auto_queue_on_voice_join` está ligado | `/diagnostico` → *Entrada automática pelo canal de espera*; `/config definir chave:auto_queue_on_voice_join valor:true` |
| A central está **aberta** no horário configurado | o jogador recebe DM de central fechada |
| O jogador **não** está bloqueado por reentrada | `/fila ver` lista os bloqueados; `/fila liberar jogador:@x` |
| O jogador **não** tem registro pendente (`hold`) nem atendimento em andamento | `/diagnostico` → *Registros pendentes (hold)* |
| O jogador **não** é da equipe (cargo de staff/admin) | staff e administradores nunca entram na fila automaticamente |
| `guild_id` é o mesmo servidor do evento | `/diagnostico` avisa quando diverge |
| O bot tem a permissão **Mover membros** e o intent de voz ativo | `/diagnostico` → *Permissões do bot* / *Evento de voz* |

> Qualquer outra falha (fila cheia, erro inesperado) agora gera **mensagem privada** ao jogador —
> antes ele ficava no canal sem saber o que aconteceu.

### Bloqueio de reentrada (anti-abandono)

Quem entra na fila (pelo painel **ou** pelo canal de voz) e sai **antes de ser chamado** fica
bloqueado por `rejoin_cooldown_minutes` (padrão **10 minutos**):

- **clicar em Entrar na fila** → resposta efêmera com o tempo restante;
- **entrar no canal de espera** → o bot remove do canal e avisa no privado;
- **`/posicao`** → mostra o tempo restante;
- **`/fila ver`** → lista os jogadores bloqueados e quando liberam.

O bloqueio **não** é aplicado quando: houve atendimento (staff chamou), a remoção foi feita pela
equipe, o jogador não compareceu, ou `rejoin_cooldown_minutes=0`.

```bash
/config definir chave:rejoin_cooldown_minutes valor:5   # 5 minutos
/fila liberar jogador:@fulano                          # libera na hora
```

## Comportamento da fila e do atendimento

| Chave | Padrão | Descrição |
| --- | --- | --- |
| `auto_queue_on_voice_join` | `true` | Entrar no canal de espera coloca o jogador na fila automaticamente |
| `rejoin_cooldown_minutes` | `10` | Bloqueio para voltar à fila depois de desistir antes de ser chamado (0 = desativado) |
| `max_queue_size` | `0` | Limite de jogadores na fila (0 = ilimitado) |
| `max_wait_minutes` | `0` | Remove quem esperar mais que isso (0 = sem limite) |
| `skip_policy` | `end` | `end` = pulado vai ao final; `hold` = fica pendente |
| `presence_timeout_minutes` | `5` | Tempo para o jogador entrar no canal após a chamada |
| `no_show_policy` | `requeue` | `requeue` = volta à fila; `close` = encerra o protocolo |
| `voice_disconnect_grace_seconds` | `120` | Tolerância antes de encerrar por queda de voz |
| `allow_staff_multi` | `false` | Permite staff em mais de um atendimento |
| `staff_auto_available` | `true` | Staff volta a DISPONÍVEL ao finalizar |
| `queue_policy_on_close` | `keep` | `keep` mantém a fila ao fechar; `clear` encerra tudo |

## Notificações, painéis e avaliações

| Chave | Padrão | Descrição |
| --- | --- | --- |
| `notifications_position_change` | `true` | Avisa o jogador quando a posição melhora |
| `position_notify_cooldown_minutes` | `10` | Intervalo mínimo entre avisos |
| `evaluations_enabled` | `true` | Envia avaliação no privado após encerrar |
| `panel_style` | `modern` | Layout do painel público: `modern` (Components V2) ou `classic` (embed) |
| `panel_refresh_seconds` | `30` | Atualização automática dos painéis |
| `average_wait_window_minutes` | `120` | Janela usada no cálculo da espera média |
| `stats_ranking_min_sample` | `3` | Mínimo de atendimentos para o ranking |
| `hidden_channels` | `false` | Modo discreto (sem menções em canais) |

## Paleta de cores da identidade

Todos os painéis e botões usam a mesma paleta (fonte única: `src/config/theme.js` → `PALETTE`):

| Token | Hex | Uso |
| --- | --- | --- |
| `INK` | `#090a0b` | fundo da área da mensagem |
| `BLACK` | `#000000` | corpo do card do painel |
| `SURFACE` | `#1a1b1d` | cards internos, faixa de horário e botões |
| `BORDER` | `#252629` | bordas e divisórias |
| `TEXT` | `#e6e6e6` | texto principal |
| `MUTED` | `#acaeb1` | texto secundário |
| `RED` / `COLORS.ACCENT` | `#ff2200` | barra de destaque, realces e ícones |
| `RED_DEEP` | `#d31e03` | realce/hover |

> O Discord não permite escolher a cor de um botão: todos usam o estilo **Secondary**
> (superfície cinza-escura), como na referência. O vermelho da marca aparece na barra do card
> (Components V2) e na barra do embed, além dos ícones e títulos.

## Estilo do painel público

O painel público usa **Components V2** (`panel_style=modern`) num único card escuro com:

- barra de destaque **vermelha `#ff2200`** à esquerda (identidade VANTUS);
- cabeçalho compacto: 🎧 + **ATENDIMENTO | VANTUS**, sem avatar e **sem texto de descrição**;
- bloco de status minimalista: apenas a manchete **ATENDIMENTO DISPONÍVEL / INDISPONÍVEL** com a
  nota de apoio (sem o rótulo "STATUS DA CENTRAL" e sem emoji);
- indicadores **NA FILA • STAFFS DISPONÍVEIS • EM ANDAMENTO**, sem emojis (a espera média saiu do
  painel — os números seguem disponíveis em `/estatisticas`);
- faixa **HORÁRIO DE ATENDIMENTO** com as janelas agrupadas por dia;
- divisor e rodapé com o texto *Fila por canal de voz* à esquerda e o botão **Entrar na Fila** à direita
  (superfície escura neutra da paleta, ícone 🎟️) — o botão só entra na fila para quem está no
  canal de voz de espera;
- os comandos `/sair` e `/posicao` aparecem como dica discreta (sem botões extras).

> **Limitação da API do Discord:** containers não podem ser aninhados nem organizados em colunas.
> A referência visual completa (painel interno + 4 cards lado a lado) está disponível em
> `npm run preview:panel`; no Discord o bot publica a versão compacta equivalente, com os mesmos dados.

Prévias locais (abrem no navegador, com os dois painéis):

```bash
npm run preview          # gera preview/panel.html e preview/staff.html
npm run preview:panel    # apenas o painel público
npm run preview:staff    # apenas o painel da equipe (embed + botões reais)
```

- Ao trocar o estilo, o bot **apaga a mensagem antiga e publica a nova** (não ficam dois painéis).
- Se a API do Discord recusar Components V2, o bot publica automaticamente o layout clássico e
  registra um aviso no log.
- O painel da staff continua em embed (é um painel denso, de leitura interna), com a barra de
  destaque em `#ff2200` e os mesmos botões na superfície escura da paleta — prévia em
  `npm run preview:staff`. Ele é **100% sem emojis**: títulos de seção, campos e botões usam texto
  puro (ex.: `CHAMAR PRÓXIMO`, `FILA DE ESPERA`, `Disponíveis`).

## Mensagens editáveis

| Chave | Descrição |
| --- | --- |
| `message_panel_title` | Título do painel público |
| `message_closed` | Texto exibido nos avisos de central fechada |

```bash
/config definir chave:message_panel_title valor:ATENDIMENTO | VANTUS
```

> O texto de introdução do painel não existe mais: o cabeçalho mostra apenas o título.

## Checklist de configuração

- [ ] `guild_id` correto
- [ ] Painel público e painel staff em canais diferentes (a staff precisa de acesso restrito)
- [ ] Categoria criada e canais de voz dentro dela
- [ ] Pelo menos um canal de atendimento listado
- [ ] Cargos de staff/admin configurados
- [ ] Horário revisado (`/horario ver`) e fuso correto
- [ ] `/diagnostico` sem ⚠️
- [ ] Painéis publicados com `/painel publicar painel:Ambos`
