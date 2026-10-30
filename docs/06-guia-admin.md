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
/fila ver                             # inclui quem está bloqueado e quando libera
/fila liberar jogador:@fulano         # remove o bloqueio de reentrada
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
