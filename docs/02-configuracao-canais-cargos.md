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
| `category_id` | Categoria 🎧・central de atendimento | `400000000000000001` |
| `wait_channel_id` | Canal de voz ⏳・aguardando-atendimento | `200000000000000001` |
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

### Editar pelo painel web

A seção **Horário de funcionamento** do painel web (`WEB_PANEL_PASSWORD` configurada) é a forma mais
rápida de ajustar a agenda: marque os dias abertos, preencha até dois turnos por dia e clique em
**Salvar horário**. O mesmo formulário troca o estado da central (automático / forçar aberta /
forçar fechada = `central_manual`).

- Ao salvar, o painel do Discord é atualizado na hora e a alteração fica registrada no canal de log.

Acima dos dias ficam três botões que valem **na hora**, sem salvar horário:

| Botão | O que faz |
| --- | --- |
| **Fechar central agora** | fecha a central mesmo dentro do horário de funcionamento (`central_manual=closed`); a fila segue a regra *Fila ao fechar a central* |
| **Abrir central agora** | abre fora do horário (`central_manual=open`) |
| **Seguir o horário** | volta ao automático (`central_manual=auto`) |

O selo ao lado mostra o estado atual e o motivo ("Fechada manualmente, mesmo dentro do horário de
funcionamento"), e cada mudança passa pelo fluxo oficial: avisos aos jogadores na fila, aplicação da
política da fila, auditoria e atualização do painel do Discord.
- Horário no formato `HH:MM`; `fechamento` menor que `abertura` continua valendo como madrugada.
- Dia sem turno = central fechada naquele dia. Nenhum turno na semana = sempre fechada.

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
> entrar em **⏳・aguardando-atendimento** (e entra na fila assim que entrar no canal).

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

O staff entra em serviço por conta própria, com `/status situacao:Disponível` ou pelo botão
**MEU STATUS** do painel da equipe — entrar no canal de voz **não** muda o status
(`staff_auto_status_on_voice_join` fica desligado por padrão). O painel é atualizado na hora
(o botão volta a funcionar na mesma hora).

### Saída do canal de espera (regra fixa)

Sair do canal **⏳・aguardando-atendimento** remove o jogador da fila imediatamente — não existe
configuração para manter alguém na fila fora do canal. Vale para:

- desconexão voluntária, quedas de conexão e remoções feitas pela moderação;
- mudança para qualquer outro canal de voz (inclusive o de atendimento antes de ser chamado).

A saída encerra o protocolo como **JOGADOR DESISTIU** e envia DM ao jogador. O bot **não**
desconecta ninguém e **não** bloqueia a volta: quem quiser pode entrar no canal e na fila de novo na
mesma hora. O evento fica registrado como `QUEUE_LEFT_WAIT_VOICE`.

### O jogador entrou no canal de espera e não entrou na fila

A entrada automática só acontece quando **todas** as condições abaixo são verdadeiras. O bot
registra o motivo no log (`[voz] …`) e o `/diagnostico` mostra o estado de cada uma:

| Condição | Como conferir / corrigir |
| --- | --- |
| `wait_channel_id` aponta para o canal **⏳・aguardando-atendimento** | `/diagnostico` → *Canal de espera*; refaça com `/setup` se o canal foi recriado |
| O jogador entrou **nesse** canal (não em outro de voz) | log `[voz] … entrou no canal X; canal de espera configurado: Y` |
| `auto_queue_on_voice_join` está ligado | `/diagnostico` → *Entrada automática pelo canal de espera*; `/config definir chave:auto_queue_on_voice_join valor:true` |
| A central está **aberta** no horário configurado | o jogador recebe DM de central fechada |
| O jogador **não** tem registro pendente (`hold`) nem atendimento em andamento | `/diagnostico` → *Registros pendentes (hold)* |
| O jogador **não** é da equipe (cargo de staff/admin) | staff e administradores nunca entram na fila automaticamente |
| `guild_id` é o mesmo servidor do evento | `/diagnostico` avisa quando diverge |
| O bot tem a permissão **Mover membros** e o intent de voz ativo | `/diagnostico` → *Permissões do bot* / *Evento de voz* |

> Qualquer outra falha (fila cheia, erro inesperado) agora gera **mensagem privada** ao jogador —
> antes ele ficava no canal sem saber o que aconteceu.

### O bot nunca tira o jogador do canal de espera

Regra fixa (não configurável): **o bot não desconecta jogadores**.

- Sair da fila (comando, remoção da equipe, saída do canal, tempo esgotado ou central fechada) **não**
  expulsa ninguém do canal de voz — o jogador continua livre para ficar ou voltar.
- Entrar no canal de espera **sempre** coloca na fila; não existe bloqueio de reentrada.
- Quem saiu da fila pode voltar imediatamente (pelo canal, pelo botão do painel ou por `/entrar`).

> A desconexão continua existindo só no fim de um **atendimento** (o jogador é retirado do canal
> `🔉・suporteⁿ`) e para staff que é tirado de serviço pelo painel.

## Comportamento da fila e do atendimento

| Chave | Padrão | Descrição |
| --- | --- | --- |
| `auto_queue_on_voice_join` | `true` | Entrar no canal de espera coloca o jogador na fila automaticamente |
| `max_queue_size` | `0` | Limite de jogadores na fila (0 = ilimitado) |
| `max_wait_minutes` | `0` | Remove quem esperar mais que isso (0 = sem limite) |
| `skip_policy` | `end` | `end` = pulado vai ao final; `hold` = fica pendente |
| `presence_timeout_minutes` | `5` | Tempo para o jogador entrar no canal após a chamada |
| `no_show_policy` | `requeue` | `requeue` = volta à fila; `close` = encerra o protocolo |
| `voice_disconnect_grace_seconds` | `120` | Tolerância antes de encerrar por queda de voz |
| `allow_staff_multi` | `false` | Permite staff em mais de um atendimento |
| `staff_auto_available` | `true` | Staff volta a DISPONÍVEL ao finalizar |
| `staff_auto_status_on_voice_join` | `false` | Entrar no canal de atendimento coloca o staff DISPONÍVEL automaticamente (desligado: só o próprio staff muda o status) |
| `wait_alert_minutes` | `3` | Avisa por DM cada staff **disponível** quando alguém espera mais de X min na sala de aguardando (`0` desliga) |
| `queue_policy_on_close` | `keep` | `keep` mantém a fila ao fechar; `clear` encerra tudo |

## Notificações, painéis e avaliações

| Chave | Padrão | Descrição |
| --- | --- | --- |
| `notifications_position_change` | `true` | Avisa o jogador quando a posição melhora |
| `position_notify_cooldown_minutes` | `10` | Intervalo mínimo entre avisos |
| `evaluations_enabled` | `true` | Envia avaliação no privado após encerrar |
| `evaluation_channel_id` | — | Canal do Discord que recebe cada avaliação (também editável no painel web e em `EVALUATION_CHANNEL_ID`) |
| `evaluations_alert_min_average` | `0` | Avisa no canal quando a média dos últimos 7 dias ficar abaixo deste valor (0 = desligado) |
| `evaluations_alert_min_sample` | `3` | Mínimo de avaliações na semana para o aviso de média |
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

O painel público usa **Components V2** (`panel_style=modern`) em **três caixas**:

| Ordem | Caixa | Conteúdo |
| --- | --- | --- |
| 1 | **status** | cabeçalho 🎧 + título, rótulo *STATUS DA CENTRAL*, manchete grande e o **relógio** à direita |
| 2 | **corpo** | *NA FILA*, *STAFFS DISPONÍVEIS* e *EM ANDAMENTO* (rótulo pequeno + número grande), uma linha divisória e o *HORÁRIO DE ATENDIMENTO* |
| 3 | **rodapé** | *Fila por canal de voz* + botão **Entrar na Fila**, a dica de `/sair` `/posicao` e o botão de avaliação |

- As manchetes de estado são **ATENDIMENTO DISPONÍVEL** (verde), **AGUARDANDO STAFF** (âmbar, fila
  aberta sem ninguém em serviço) e **FORA DO HORÁRIO DE ATENDIMENTO** (vermelho).
- **Fora do horário** os indicadores **não aparecem**: o corpo mostra só o horário.
- A barra da caixa de status acompanha o estado. O corpo é caixa neutra (sem barra) e o rodapé fica
  sempre em `#ff2200`.
- O **relógio** é uma arte PNG enviada junto com a mensagem (`assets/central-*.png`, geradas por
  `npm run art`) e exibida como acessório da seção — no Discord não existe largura de imagem
  configurável, então o tamanho é o do arquivo.
- A espera média continua fora do painel (os números ficam em `/estatisticas`).

> **Limitação da API do Discord:** containers **não podem ser aninhados** e não existe layout em
> colunas — os indicadores não podem ficar lado a lado como nos cards da referência. Eles ficam no
> mesmo bloco, um abaixo do outro, que é o mais próximo possível. A prévia em
> `npm run preview:panel` é renderizada a partir do payload real do painel.

Prévias locais (abrem no navegador, com os dois painéis):

```bash
npm run preview          # gera preview/panel.html e preview/staff.html
npm run preview:panel    # apenas o painel público
npm run preview:staff    # apenas o painel da equipe (embed + botões reais)
npm run art              # regera as artes do relógio em assets/
```

- Ao trocar o estilo, o bot **apaga a mensagem antiga e publica a nova** (não ficam dois painéis).
- Se a API do Discord recusar Components V2, o bot publica automaticamente o layout clássico e
  registra um aviso no log.
- O painel da staff continua em embed (é um painel denso, de leitura interna), com a barra de
  destaque em `#ff2200` e os mesmos botões na superfície escura da paleta — prévia em
  `npm run preview:staff`. Ele é **100% sem emojis**: títulos de seção, campos e botões usam texto
  puro (ex.: `CHAMAR`, `FILA DE ESPERA`, `AGORA`).
- O bloco **EQUIPE** é dividido em dois grupos: **DE SERVIÇO** (disponível ou em atendimento) e
  **FORA DE SERVIÇO** (ausente, indisponível ou bloqueado), cada um com a contagem no título. Dentro
  do grupo a ordem é **pelo horário da escala**, do turno mais cedo para o mais tarde
  (`13:12 → 15:36 → 16:48 → 20:24`); empate desempata por status e depois por id. Quem não tem escala
  cadastrada vai para o fim. A lista para em 20 nomes por grupo (`… e mais N staff`) para não
  estourar o limite de 4096 caracteres do embed.
  Staff bloqueado pela administração nunca aparece como "de serviço".
- **Quem tem o cargo aparece sempre**: a EQUIPE é a união de quem já entrou em serviço com quem tem o
  cargo no Discord. Membro com o cargo e sem status registrado entra em **FORA DE SERVIÇO** com
  `sem escala` — não fica invisível até o primeiro turno.
- **Rodapé enxuto**: `Painel restrito à equipe • atualiza a cada 30s`. A marca já está no título e a
  hora vem do `timestamp` do embed (o "Hoje às 11:07" que o Discord cola no fim do rodapé) — repetir
  "VANTUS", "Central de Atendimento" e "Atualização automática" só duplicava informação. O valor de
  segundos segue `panel_refresh_seconds`.
- Os botões ficam em **duas linhas** (`CHAMAR · ESCOLHER · PULAR · DEVOLVER · FINALIZAR` e
  `ATUALIZAR · MEU STATUS · REATIVAR · REMOVER`). Os rótulos têm todos **5 a 10 caracteres** de
  propósito: o Discord dimensiona o botão pelo texto, então tamanhos parecidos mantêm as colunas
  alinhadas. Botão que não se aplica ao momento fica desabilitado **sem mudar de largura**.
- As métricas do rodapé são **três cartões** em uma linha: `AGORA` (na fila · atendendo ·
  livres), `TEMPOS` (espera · duração, com `—` quando não há amostra) e `HOJE` (concluídos ·
  nota de 4, só quando há avaliação · pendentes). Antes eram 9 campos soltos em 3 andares de caixas.
- **Estado vazio**: sem fila, sem atendimento, sem pendente, ninguém livre e nada concluído hoje, os
  três cartões viram um único campo `SEM MOVIMENTO` com a situação da central e a última atividade
  em timestamp relativo (`há 2 horas`).
- A linha de cada staff mostra o **horário da escala**, não o status: `@staff — hoje 14:00 às 22:00`,
  `@staff — em turno até 20:00`, `@staff — amanhã 14:00 às 22:00`, `@staff — Qua 14:00 às 22:00` ou
  `@staff — sem escala` (turno nenhum cadastrado). Os rótulos DISPONÍVEL/INDISPONÍVEL/AUSENTE não
  aparecem mais — o grupo já informa a disponibilidade. Só dois complementos continuam na linha,
  porque não são disponibilidade: `• em atendimento` (está com um jogador) e `• bloqueado`.

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
