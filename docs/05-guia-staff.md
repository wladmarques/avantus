# 05 • Guia da equipe (staff)

O painel da equipe fica em **#painel-staff** e é atualizado automaticamente.

## Antes de atender

1. Entre em um dos canais **🔊 ATENDIMENTO 01/02/03**.
2. Confirme seu status com **🟢 MEU STATUS** → *Disponível* (ou `/status situacao:Disponível`).

> **Regra de ouro:** o bot só permite chamar um jogador se você estiver conectado a um canal
> de voz válido da central. Sem isso, ele responde:
> *“Você precisa estar conectado a um canal de voz de atendimento para chamar um jogador.”*

## Chamar jogadores

**📞 CHAMAR PRÓXIMO** — pega automaticamente o primeiro da fila, move o jogador para o seu canal,
registra o início e muda seu status para 🔴 EM ATENDIMENTO.

**👤 CHAMAR ESPECÍFICO** — escolhe qualquer jogador da fila. O **motivo é obrigatório** e fica
registrado como alteração da ordem (aparece com ⚠️ no painel e nos logs).

**Múltiplos atendimentos:** cada staff atende um jogador por vez. Admins podem liberar mais de um
por staff com `/config definir chave:allow_staff_multi valor:true`.

## Durante o atendimento

- O jogador aparece em **📞 EM ATENDIMENTO** com protocolo, staff, horário e duração.
- **Presença:** ✅ confirmada quando ele entra no canal / ⏳ aguardando.
- Se o jogador cair do canal, há uma tolerância (`voice_disconnect_grace_seconds`, padrão 120s).
  Passado o tempo, o protocolo é encerrado como **JOGADOR DESCONECTOU**.
- Se você cair do canal, seu status vai para ⚫ INDISPONÍVEL. Se não voltar dentro da tolerância,
  o protocolo é encerrado como **STAFF DESCONECTOU** e o jogador volta para a fila.

## Ações disponíveis

| Botão | Efeito |
| --- | --- |
| ✅ FINALIZAR | encerra seu atendimento, calcula duração, envia a avaliação ao jogador e libera você |
| 🔄 DEVOLVER À FILA | o jogador volta ao **final** da fila e você é liberado |
| ⏭️ PULAR JOGADOR | move o jogador para o final da fila ou o mantém pendente (conforme configuração) — **motivo obrigatório** |
| 🚫 REMOVER DA FILA | remove o jogador (fila ou atendimento) com **justificativa obrigatória** |
| ▶️ REATIVAR PENDENTE | devolve um jogador pendente para a fila |
| 🔄 ATUALIZAR PAINEL | força a atualização das informações |
| 🟢 MEU STATUS | altera sua disponibilidade |

## Seus status

| Status | Quando usar |
| --- | --- |
| 🟢 DISPONÍVEL | pronto para receber chamadas |
| 🔴 EM ATENDIMENTO | aplicado automaticamente quando você chama alguém |
| 🟡 AUSENTE | pausa curta (almoço, AFK) |
| ⚫ INDISPONÍVEL | fora de serviço |

Ao finalizar, você volta para 🟢 DISPONÍVEL — **exceto** se você mesmo definiu 🟡 AUSENTE ou
⚫ INDISPONÍVEL. Nesse caso sua escolha é respeitada.

## Comandos de staff

| Comando | Uso |
| --- | --- |
| `/chamar` | chama o próximo |
| `/chamar jogador:@fulano motivo:...` | chama fora da ordem (motivo obrigatório) |
| `/finalizar observacao:...` | encerra seu atendimento com observação |
| `/devolver motivo:...` | devolve o jogador ao final da fila |
| `/pular jogador:@fulano motivo:...` | pula um jogador |
| `/status situacao:Disponível` | altera sua disponibilidade |

## Boas práticas

- Finalize sempre ao terminar: protocolo aberto trava sua próxima chamada.
- Use **Chamar específico** apenas em situações justificadas — o log registra quem alterou a ordem e por quê.
- Não remova jogadores sem justificativa real: toda ação fica no histórico administrativo.
- Deixe a disponibilidade em ⚫ INDISPONÍVEL ao sair de serviço, para não distorcer a espera média.
