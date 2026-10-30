# 08 • Testes e checklist de QA

## Como rodar

```bash
npm test             # 76 testes (node:test), sem token e sem internet
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
| `tests/persistence.test.js` | fila/protocolos/staff após reinício, recuperação de registros órfãos, painel não duplicado e retomado |
| `tests/panels.test.js` | painel V2 (container único, barra laranja, sem avatar, indicadores sem emojis, botão único), status disponível/indisponível, layout clássico, troca de estilo sem duplicar, fallback, painel staff, reconstrução, central fechada |
| `tests/statistics.test.js` | conclusões, desistências, rankings, histórico com responsável, logs no canal |
| `tests/schedule.test.js` | janelas normais, fechamento, virada de madrugada, dia sem janela, fuso de São Paulo, períodos |
| `tests/cooldown.test.js` | bloqueio de 10 min ao desistir, DM com tempo restante, expulsão do canal de espera, expiração, staff não gera bloqueio, configuração 0/3 min, `/fila liberar` |
| `tests/commands.test.js` | contexto do comando (`client`/`env`/`runtime`), `/setup` e `/diagnostico` ponta a ponta |
| `tests/permissions.test.js` | cargos, Administrator, dono do servidor, mensagens de erro |
| `tests/interactions.test.js` | botão entrar, bloqueio de permissão, chamar próximo, menu de seleção, modal de remoção, avaliação |

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
- [ ] Painel público atualiza sozinho (fila, staffs, atendimentos, espera média)
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
