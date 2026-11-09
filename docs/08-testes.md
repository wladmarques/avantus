# 08 • Testes e checklist de QA

## Como rodar

```bash
npm test             # 117 testes (node:test), sem token e sem internet
npm run lint         # valida a sintaxe de todos os arquivos
npm run check:tracked # garante que todo arquivo-fonte está versionado
```

Os testes usam banco SQLite real em arquivo temporário e um `MemoryGateway` que simula o Discord
(membros, canais de voz, DMs, mensagens e permissões). Cada teste cria e destrói seu próprio banco.

## Cobertura

| Arquivo | Cenários |
| --- | --- |
| `tests/queue.test.js` | entrada, protocolo/posição, duplicidade, central fechada, desistência, saída do servidor, chamada sem voz, **duas chamadas simultâneas**, staff ocupado, fila vazia |
| `tests/attendance.test.js` | chamada + movimentação, presença, finalização + avaliação, avaliação única, devolução à fila, políticas de pulo, motivo obrigatório, não compareceu, staff saiu, limpeza de fila |
| `tests/voice.test.js` | presença por evento de voz, desconexão com tolerância, staff conectado/desconectado, staff que não retorna, jogador sai da espera |
| `tests/shiftAbsence.test.js` | não entrada em serviço: registro após a tolerância, aviso aos cargos com `allowed_mentions`, sem repetição por verificação nem após reinício, "atrasou" ao entrar depois, "faltou" ao terminar o turno, tolerância 0, canal/cargos configuráveis e payload no `/api/overview` |
| `tests/hourBank.test.js` | escala (substituição, turno noturno, validação), sessão aberta/fechada pelo status, atendimento mantendo a contagem, atraso, relatório, resumo, aviso de 5 min sem duplicar, fechamento de sessão esquecida e desligamento do módulo |
| `tests/webPanel.test.js` | autenticação do painel (401, senha errada, sessão, logout), painel desligado sem senha, salvar/remover escala pela API, relatório e sessões, assets estáticos |
| `tests/availability.test.js` | entrada na fila só com staff disponível e central aberta: botão desabilitado (V2 e clássico), recusa com `SEM_STAFF`, staff ocupado, liberação imediata, entrada por voz bloqueada |
| `tests/voiceAutoJoin.test.js` | fluxo real do evento `voiceStateUpdate` (entra na fila ao entrar no canal de espera), servidor divergente, entrada automática desligada, canal de espera ausente, outro canal de voz, fila cheia com aviso ao jogador, volta imediata após sair da fila, membro fora do cache, saída do canal tirando da fila (evento) |
| `tests/persistence.test.js` | fila/protocolos/staff após reinício, recuperação de registros órfãos, painel não duplicado e retomado |
| `tests/panels.test.js` | painel V2 (caixas empilhadas, cores por estado, relógio, indicadores, botão único neutro), status disponível/indisponível, layout clássico, troca de estilo sem duplicar, fallback, painel staff, reconstrução, central fechada |
| `tests/statistics.test.js` | conclusões, desistências, rankings, histórico com responsável, logs no canal |
| `tests/schedule.test.js` | janelas normais, fechamento, virada de madrugada, dia sem janela, fuso de São Paulo, períodos |
| `tests/commands.test.js` | contexto do comando (`client`/`env`/`runtime`), `/setup` e `/diagnostico` ponta a ponta |
| `tests/permissions.test.js` | cargos, Administrator, dono do servidor, mensagens de erro |
| `tests/interactions.test.js` | botão entrar, bloqueio de permissão, chamar próximo, menu de seleção, modal de remoção, avaliação |
| `tests/waitAlert.test.js` | aviso de espera longa: DM para staff disponível após 3 min, uma vez por jogador, sem avisar quem está fora de serviço/bloqueado, limite configurável e `0` desliga |
| `tests/hoursReset.test.js` | painel web: zerar horas de um staff e de toda a equipe, sessão em andamento reiniciada (não apagada), login obrigatório e auditoria `HOURS_RESET` |
| `tests/staffPanelGroups.test.js` | EQUIPE separada em DE SERVIÇO / FORA DE SERVIÇO: quem entra em cada grupo, bloqueado nunca como de serviço, ordem interna, horário da escala na linha (hoje/amanhã/em turno/sem escala) e **ordem da lista pelo horário da escala**, textos de grupo vazio e corte da lista longa |
| `tests/publicPanelLayout.test.js` | layout do painel público: 5 caixas com a central aberta, 2 fechada, relógio por estado, arquivo de arte existente, rodapé e ausência de containers aninhados |
| `tests/panelFooter.test.js` | rodapé dos painéis: texto curto sem repetir marca/hora, intervalo vindo de `panel_refresh_seconds`, `timestamp` preservado e fallback de 30s |
| `tests/staffButtons.test.js` | layout dos botões do painel da equipe: 5+4, máximo de 5 por linha, rótulos de 5–10 caracteres, ordem por fluxo, IDs preservados, estilo neutro e botão desabilitado sem mudar de tamanho |
| `tests/staffPanelMetrics.test.js` | métricas do painel em três cartões (AGORA/TEMPOS/HOJE): valores, `—` sem amostra, nota só com avaliação, singular/plural e o estado vazio `SEM MOVIMENTO` |
| `tests/staffPanelRosterMembers.test.js` | EQUIPE listando **todos** os membros com o cargo de atendimento: quem nunca entrou em serviço aparece em FORA DE SERVIÇO com `sem escala`, contagem do grupo, `registered: false`, saída ao perder o cargo e a fila continuando fechada |
| `tests/webPanelRoster.test.js` | painel web separando **escala fixa** (cargo `staff_panel_role_ids`) de **apoio** (atendimentos aleatórios): `/api/overview` com `group`/`onRoster`, cargos devolvidos na resposta, fallback por turno cadastrado, `rosterIds` do `StaffService` e a paridade de listas entre o painel web e a EQUIPE do Discord |
| `tests/panelScheduleLabel.test.js` | `scheduleSummary`/`describeSchedule`: turno em andamento, dois turnos no dia, virada de madrugada, próximo dia, dia da semana, revezamento A/B e `sem escala` |
| `tests/staffPanelRoles.test.js` | filtro da EQUIPE por cargo + resiliência do cache (falha/vazio não esvazia o painel), throttle da sincronização, `roleCacheInfo` do `/diagnostico` |
| `tests/staffServiceStatus.test.js` | entrar na call não coloca o staff em serviço (nem abre sessão do banco de horas), staff fora de serviço não chama jogador, chamada após definir Disponível, `allow_staff_multi` |
| `tests/noWaitKick.test.js` | o bot nunca tira o jogador do canal de espera (sair da fila, remoção pela equipe, fechar a central, tempo esgotado), volta imediata liberada e ausência do bloqueio de reentrada |
| `tests/staffAdmin.test.js` | bloquear staff (sai de serviço, não volta pelo `/status`, nem pela call, nem no status em massa/recuperação), desbloquear, remover da equipe, 409 em atendimento, exigência de login |
| `tests/evaluationDelivery.test.js` | payload dos botões de nota, fallback no canal do painel com DM fechada, botão Avaliar atendimento, `/avaliar` sem protocolo |

Resultado esperado:

```
# tests 76
# pass 76
# fail 0
```

## Checklist manual (após o deploy)

**Fila**
- [ ] Entrar pela fila pelo botão e por `/entrar`
- [ ] Posição e protocolo corretos; segunda tentativa bloqueada
- [ ] Sair pelo botão, `/sair` e por saída do servidor
- [ ] Fila bloqueada com a central fechada e liberada ao abrir

**Atendimento**
- [ ] Chamar próximo move o jogador e muda o status do staff
- [ ] Staff sem canal de voz recebe a mensagem de bloqueio
- [ ] Dois staffs chamando ao mesmo tempo recebem jogadores diferentes
- [ ] Staff não consegue abrir um segundo atendimento
- [ ] Chamar específico exige motivo e registra no log
- [ ] Finalizar calcula duração, libera o staff e envia a avaliação

**Voz**
- [ ] Jogador movido para a espera ao entrar
- [ ] Acesso liberado só para o jogador chamado
- [ ] Jogador que sai do canal é encerrado após a tolerância
- [ ] Staff que cai do canal marca INDISPONÍVEL
- [ ] Movimentação para canal fora da central é bloqueada

**Painéis**
- [ ] Painel público atualiza sozinho (fila, staffs, atendimentos)
- [ ] Painel staff lista jogadores, tempos e status
- [ ] Botões funcionam após reiniciar o bot
- [ ] `/painel reconstruir` não deixa mensagens duplicadas

**Administração**
- [ ] `/central abrir|fechar` reflete no painel
- [ ] `/horario definir` fecha/abre nos horários certos
- [ ] `/estatisticas` e `/avaliacoes` mostram números coerentes
- [ ] `/historico protocolo` mostra a linha do tempo
- [ ] `/diagnostico` sem avisos

**Resiliência**
- [ ] Reiniciar a aplicação na SquareCloud mantém fila e atendimentos
- [ ] Banco recuperado de `.bak` quando corrompido (teste em cópia)
- [ ] Logs de erro chegam ao canal de auditoria
