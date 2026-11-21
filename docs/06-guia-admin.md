# 06 • Guia administrativo

## Primeiros passos

```
/setup criar_cargos:true      # cria canais, cargos e publica os painéis
/diagnostico                  # valida a configuração
/painel publicar painel:Ambos # republica/atualiza os painéis
```

## Controle da central

| Comando | Efeito |
| --- | --- |
| `/central abrir` | abre fora do horário (modo manual) |
| `/central fechar limpar_fila:true motivo:...` | fecha e (opcionalmente) encerra a fila |
| `/central alternar` | inverte o estado atual |
| `/central status` | mostra situação, modo e agenda |
| `/config definir chave:central_manual valor:auto` | volta ao controle por horário |

Ao fechar a central:

- novas entradas são bloqueadas;
- atendimentos em andamento **continuam**;
- a fila é mantida ou encerrada conforme `queue_policy_on_close` (ou o parâmetro `limpar_fila`);
- o painel público passa a mostrar **FECHADA** e o próximo horário de abertura.

### A equipe abre e fecha a central

A central acompanha a equipe automaticamente:

1. Um staff define o status como **DISPONÍVEL** (botão do painel da equipe, `/status` ou
   `/staff`) e a central estava seguindo o horário: ela **abre na hora**, mesmo fora do horário
   programado. Quem estiver no canal de espera já pode entrar na fila.
2. Quando **ninguém** mais está em serviço (nenhum staff disponível **nem** em atendimento), a
   central **volta ao horário programado** — se a agenda diz fechada, ela fecha de novo e quem estava
   na fila recebe o aviso no privado. Staff em atendimento conta como em serviço: a central não
   fecha no meio de um atendimento.
3. O que **você** fez manualmente manda: se você fechou a central pelo painel (ou por
   `/central fechar`), nenhum staff abrindo o status derruba esse fechamento; e se você abriu
   manualmente, ela continua aberta quando a equipe sair.

No painel web, o cartão da central mostra **“Aberta porque a equipe entrou em serviço”**; use
**Seguir o horário** para devolver ao automático. Para desligar essa automação:
`/config definir chave:central_auto_open_on_staff valor:false`.

## Horários

```
/horario ver
/horario definir dia:Sábado abertura:12:00 fechamento:00:00
/horario fechar_dia dia:Segunda
/horario modelo
```

Fuso: `America/Sao_Paulo`. Janelas com fechamento menor que a abertura cruzam a madrugada.

## Painéis

| Comando | Quando usar |
| --- | --- |
| `/painel publicar` | depois de mudar canais, textos ou configurações |
| `/painel atualizar` | para forçar a atualização imediata |
| `/painel reconstruir` | quando a mensagem foi apagada à mão |

Estilo do painel público: `modern` (Components V2, padrão) ou `classic` (embed).

```
/config definir chave:panel_style valor:classic
/painel publicar painel:Público
```

Os painéis são **mensagens persistentes**: o bot guarda canal + ID da mensagem no banco e sempre
edita a mesma mensagem. Reiniciar o bot não duplica nada.

## Fila

```
/fila ver                             # fila, atendimentos e pendentes
/fila pular jogador:@fulano motivo:"Sem resposta"
/fila remover jogador:@fulano motivo:"Conduta inadequada"
/fila reativar jogador:@fulano
/fila limpar motivo:"Manutenção"
```

Toda ação exige motivo/justificativa (quando aplicável) e gera log com o responsável.

## Equipe

```
/staff lista
/staff status membro:@fulano situacao:Ausente
```

Status: `DISPONIVEL`, `EM_ATENDIMENTO`, `AUSENTE`, `INDISPONIVEL`.
Admins também podem alterar o status de qualquer membro; staffs alteram apenas o próprio.

## Banco de horas

1. Abra o **painel web** (endereço do app + senha `WEB_PANEL_PASSWORD`).
2. Em **Equipe**, abra o menu **⋮** da linha do staff → **Editar escala** e cadastre os turnos da
   semana. O mesmo menu tem **Alterar nome**, **Zerar horas**, **Bloquear**, **Tirar de serviço**
   e **Remover**.
   Turnos que cruzam a meia-noite são aceitos (`22:00` → `02:00`).
3. As horas passam a contar sozinhas quando o staff fica **Disponível**.
4. Em **Sessões** (clique na linha) você vê entrada, saída, duração e atrasos de cada dia.
5. Em **Presença** aparece quem **não entrou em serviço** no horário da escala (`faltou`, `em atraso`
   ou `compareceu` com atraso). O registro é automático e, no Discord, os cargos da administração
   (`hour_bank_absence_role_ids`) são avisados no **canal de logs de atendimento** assim que o turno passa da
   tolerância (`hour_bank_absence_minutes`, padrão 10 min).
   No topo da seção, o seletor **Todos os staff** filtra a tabela e os cartões por uma pessoa e abre o
   resumo dela (status, turno, sessão atual, horas, atrasos, faltas e a escala semanal). A escolha continua
   valendo no refresh automático; **Todos os staff** volta ao agregado.
6. Use **CSV** para exportar o período e fechar a folha de horas.

```bash
/banco equipe                                  # resumo dos últimos 7 dias
/banco escala membro:@x dia:Sábado inicio:20:00 fim:02:00
/banco limpar membro:@x
```

Detalhes técnicos e solução de problemas: [09-banco-de-horas.md](09-banco-de-horas.md).

## Relatórios

```
/estatisticas periodo:Hoje
/estatisticas periodo:7d
/estatisticas periodo:30d
/estatisticas periodo:Mes
/estatisticas periodo:Total
```

Mostra: total encerrado, concluídos, espera média, maior espera, duração média, avaliação média,
horários de pico, distribuição de resultados e ranking da equipe.

**Como o ranking é calculado:**  
`pontuação = atendimentos concluídos × (0,8 + 0,2 × média das avaliações / 4)`  
Volume é o critério principal e a avaliação ajusta até 20%. O tempo médio é exibido como
informação e **não penaliza atendimentos longos** — evitando incentivo a atendimentos apressados.
Staffs com menos de `stats_ranking_min_sample` atendimentos aparecem como *(amostra pequena)*.

## Avaliações

```
/avaliacoes periodo:30d
```

Distribuição por nota, média por staff e últimas avaliações recebidas.

## Histórico

```
/historico protocolo numero:12
/historico jogador jogador:@fulano
/historico ultimos
```

Cada protocolo guarda: jogador, staff, entrada, início, encerramento, espera, duração, resultado,
motivo de encerramento e a linha do tempo de eventos (auditoria).

**Resultados possíveis:** ATENDIMENTO CONCLUÍDO, JOGADOR DESISTIU, JOGADOR DESCONECTOU,
STAFF DESCONECTOU, ATENDIMENTO CANCELADO, JOGADOR REMOVIDO, JOGADOR NÃO COMPARECEU.

## Fila fechada para novas entradas

A entrada na fila exige **central aberta** e **pelo menos um staff DISPONÍVEL**. Se o botão
*Entrar na Fila* estiver desabilitado:

1. confira se a central está aberta (`/central ver`, `/horario ver`);
2. veja o status da equipe com `/staff status` — quem estiver **INDISPONÍVEL**, **AUSENTE** ou
   **EM ATENDIMENTO** não conta como disponível;
3. coloque alguém como **Disponível** (o botão é reabilitado na hora);
4. `/diagnostico` mostra a linha **Entrada na fila liberada** com o motivo do bloqueio.

## Jogador entrou no canal de espera e não entrou na fila

1. Rode `/diagnostico` e confira o bloco de **fila por voz** (canal de espera, entrada automática,
   registros pendentes, bloqueios ativos e permissões).
2. Veja o log com escopo `voice`/`attendance`: cada tentativa registra `[voz] …` com o motivo.
3. Causas comuns: canal de espera recriado sem atualizar `wait_channel_id`, jogador com bloqueio de
   reentrada, cargo de staff no jogador, fila cheia (`max_queue_size`) ou central fechada no horário.
4. O jogador sempre recebe uma DM quando a entrada automática falha — pedir o print ajuda a
   identificar a causa na hora.

## Aviso no celular quando alguém entra na fila

O painel web tem a seção **Notificações**: cada entrada na fila vira um push no celular do dono,
pelo app **ntfy** (grátis, sem conta obrigatória). Nada de WhatsApp: o ntfy entrega push nativo,
com som, mesmo com a tela apagada.

Configuração (uma vez):

1. Instale o app **ntfy** (Android/iOS) e assine um tópico — ele funciona como senha, então use algo
   longo e aleatório (ex.: `vantus-fila-8j3k9m2x`).
2. No painel: **Notificações** → ligue a chave, informe o tópico (o endereço padrão é
   `https://ntfy.sh`) e clique em **Enviar teste**. O cartão mostra `ok 200` quando o app recebe.
3. Opcional: crie uma conta em `ntfy.sh`, gere um **access token** e cole em **Token de acesso** para
   proteger o tópico. O painel nunca mostra o token inteiro.

Comportamento:

- uma mensagem por pessoa que entra na fila (nome, posição, protocolo e horário);
- se a pessoa entrar na call com a central fechada ou sem staff, chega um aviso de **tentativa
  bloqueada** com o motivo (pode ser desligado no painel);
- sair da fila, ser chamado ou finalizar o atendimento **não** gera push;
- falha de envio nunca impede alguém de entrar na fila: aparece como aviso no log (`escopo push`) e
  como último status no painel.

### A notificação está demorando? Onde está o atraso

O painel mostra o tempo de publicação: **“Último envio: ok 200 · 132 ms às 20:14”**. Esse número é
do **bot até o ntfy** (rede + aceite do servidor) e não inclui a entrega no aparelho.

- **Número baixo (dezenas/centenas de ms)** → o bot publicou na hora; o atraso é na entrega. Causas
  comuns, em ordem:
  1. **App do Android vindo da Play Store** usa o Firebase (FCM) e, com o celular parado, o Google
     pode segurar a mensagem por minutos. Solução: na tela do tópico, ative **Instant delivery**
     (aparece uma notificação fixa do serviço) — ou instale a versão do **F-Droid**, que não usa
     Firebase e é sempre instantânea.
  2. **Otimização de bateria** do fabricante: Configurações → Apps → ntfy → Bateria → **Sem
     restrições**. Vale principalmente para Xiaomi, Samsung, Motorola e Huawei.
  3. **Não perturbe / canais de notificação**: as mensagens vão com prioridade **alta**, que é a que
     aparece como pop-up; confira em Configurações → Apps → ntfy → Notificações.
  4. **Navegador/PWA no computador**: só recebe com o navegador aberto e com a permissão de
     notificação concedida para o site.
- **Número alto ou “falhou”** → o problema está do lado do bot/servidor: veja o log com o escopo
  `push` (timeout de 8 s, HTTP 401/403 por token errado, 429 por excesso de envios do ntfy.sh).
- Reforço de código: o aviso é publicado **antes** das chamadas ao Discord (mover para a call, DM de
  confirmação, log e painéis), então ele não fica na fila atrás delas; e toda entrada na fila sai com
  prioridade **alta**, que evita o agrupamento do modo de espera do Android.

## Configurações

```
/config ver
/config ver grupo:Fila
/config definir chave:presence_timeout_minutes valor:7
/config definir chave:attendance_channel_ids valor:["123","456"]
```

Referência completa das chaves: [02-configuracao-canais-cargos.md](02-configuracao-canais-cargos.md).

## Logs

O canal de logs recebe, com autor e protocolo:

- entrada e saída da fila;
- chamadas (inclusive fora da ordem, com motivo);
- início, presença e encerramento de atendimentos;
- pulos, devoluções, reativações e remoções;
- mudanças de status da equipe;
- abertura/fechamento da central (manual e automático);
- falhas do sistema (`SYSTEM_ERROR`, `CLIENT_ERROR`).

## Operação e manutenção

- **Backup:** copie `data/vantus.sqlite` (o bot também mantém `vantus.sqlite.bak`).
- **Reinício:** fila, atendimentos, staffs e painéis são recuperados automaticamente.
- **Deploy:** envie o código sem a pasta `data/` para preservar o banco.
- **Sem banco externo:** todo o armazenamento é local à aplicação (SquareCloud).
