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
| Clica em **Entrar na fila** (painel/comando) | registra o protocolo e **move para o canal de espera** |
| **Entra no canal de espera** | **entra na fila automaticamente** (gera protocolo e envia DM) |
| Sai do canal de espera | **sai da fila** (desistência) e recebe **bloqueio de 10 min**, salvo se `leave_queue_on_wait_exit=false` |
| É chamado por um staff | vai para o canal de atendimento e a presença é confirmada |

```bash
/config definir chave:auto_queue_on_voice_join valor:false   # exige o clique no painel
/config definir chave:leave_queue_on_wait_exit valor:false   # sair do canal não remove da fila
```

> O bot nunca move alguém para um canal sem a pessoa estar conectada em voz: se o jogador
> clicar em **Entrar na fila** sem estar em nenhum canal, ele recebe a instrução no privado para
> entrar em **AGUARDANDO ATENDIMENTO** (e entra na fila assim que entrar no canal).

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
| `leave_queue_on_wait_exit` | `true` | Sair do canal de espera remove o jogador da fila |
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

## Estilo do painel público

O painel público usa **Components V2** (`panel_style=modern`) num único card escuro com:

- barra de destaque **laranja** à esquerda (identidade VANTUS);
- cabeçalho compacto: 🎧 + **ATENDIMENTO | VANTUS** + descrição curta (sem avatar);
- bloco de status com indicador circular e manchete **ATENDIMENTO DISPONÍVEL / INDISPONÍVEL**;
- indicadores **NA FILA • STAFFS DISPONÍVEIS • EM ANDAMENTO • ESPERA MÉDIA**, sem emojis;
- faixa **HORÁRIO DE ATENDIMENTO** com as janelas agrupadas por dia;
- divisor e rodapé com o texto *Fila por canal de voz* à esquerda e o botão **Entrar na Fila** à direita;
- os comandos `/sair` e `/posicao` aparecem como dica discreta (sem botões extras).

> **Limitação da API do Discord:** containers não podem ser aninhados nem organizados em colunas.
> A referência visual completa (painel interno + 4 cards lado a lado) está disponível em
> `npm run preview:panel`; no Discord o bot publica a versão compacta equivalente, com os mesmos dados.

- Ao trocar o estilo, o bot **apaga a mensagem antiga e publica a nova** (não ficam dois painéis).
- Se a API do Discord recusar Components V2, o bot publica automaticamente o layout clássico e
  registra um aviso no log.
- O painel da staff continua em embed (é um painel denso, de leitura interna).

## Mensagens editáveis

| Chave | Descrição |
| --- | --- |
| `message_panel_title` | Título do painel público |
| `message_panel_description` | Texto de introdução do painel |
| `message_closed` | Texto exibido quando a central está fechada |

```bash
/config definir chave:message_panel_description valor:Precisa de ajuda com o FiveM? Entre na fila e aguarde um membro da equipe.
```

## Checklist de configuração

- [ ] `guild_id` correto
- [ ] Painel público e painel staff em canais diferentes (a staff precisa de acesso restrito)
- [ ] Categoria criada e canais de voz dentro dela
- [ ] Pelo menos um canal de atendimento listado
- [ ] Cargos de staff/admin configurados
- [ ] Horário revisado (`/horario ver`) e fuso correto
- [ ] `/diagnostico` sem ⚠️
- [ ] Painéis publicados com `/painel publicar painel:Ambos`
