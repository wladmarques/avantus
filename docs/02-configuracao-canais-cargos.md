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

## Comportamento da fila e do atendimento

| Chave | Padrão | Descrição |
| --- | --- | --- |
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

O painel público usa **Components V2** (`panel_style=modern`): **um único card compacto** com
cabeçalho (título + subtítulo + ícone do servidor), bloco de status, indicadores em linha,
horário de atendimento e uma faixa final com o texto explicativo à esquerda e o botão
**Entrar na Fila** à direita. Botões secundários (*Minha posição* e *Sair da fila*) ficam na linha
abaixo do texto.

```bash
/config definir chave:panel_style valor:classic   # volta para o layout em embed
/painel publicar painel:Público                    # recria a mensagem no novo estilo
```

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
