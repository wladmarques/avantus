# 04 • Guia do jogador

## Como pedir atendimento

Existem dois caminhos — os dois funcionam:

**Opção A — pelo painel**
1. Vá até o canal **#central-atendimento**.
2. Clique em **🎫 ENTRAR NA FILA**.
3. Você é colocado na fila e **movido automaticamente** para **🔊 AGUARDANDO ATENDIMENTO**.
   (Se você não estiver em nenhum canal de voz, entre nele — não é preciso clicar de novo.)

**Opção B — só entrando no canal de voz**
1. Entre direto no canal **🔊 AGUARDANDO ATENDIMENTO**.
2. O bot **te coloca na fila automaticamente**: você recebe o protocolo e a posição no privado.

Em qualquer caso: quando um staff te chamar, você recebe uma mensagem privada e é movido
automaticamente para o canal de atendimento.

## O que aparece na mensagem privada

```
Você entrou na fila de atendimento da VANTUS.

Protocolo: #0001
Posição na fila: 1º

Permaneça no canal de espera. Nossa equipe realizará seu atendimento assim que possível.
```

Você também é avisado quando sua posição melhora — sem spam: os avisos respeitam um intervalo mínimo.

## Durante o atendimento

- Você é movido para o canal de voz do staff que te chamou.
- Só você tem acesso àquele canal naquele momento (outros jogadores da fila não entram).
- Você tem alguns minutos para comparecer ao canal. Se não aparecer, o protocolo é encerrado
  como **JOGADOR NÃO COMPARECEU** e você pode voltar à fila.

## Desistindo

- Clique em **❌ SAIR DA FILA** no painel ou use `/sair`.
- **Sair do canal de espera remove você da fila na hora** — inclusive se você for movido para
  outro canal ou cair a conexão.
- ⏳ **Ao desistir antes de ser chamado, você fica 10 minutos sem poder voltar** (nem pelo painel,
  nem entrando no canal de espera). O bot informa o tempo restante — inclusive em `/posicao`.
  A administração pode reduzir/desativar esse bloqueio ou liberar você na hora.
- Seu protocolo é encerrado como **JOGADOR DESISTIU** e o acesso ao canal de espera é removido.
- Se você sair do servidor, o bot remove você da fila automaticamente.

## Depois do atendimento

Você recebe uma avaliação no privado:

> Como foi seu atendimento pela equipe VANTUS?
> ⭐ Muito bom · ⭐ Bom · ⭐ Regular · ⭐ Ruim

Sua nota fica vinculada ao protocolo e ao staff responsável. Você pode avaliar apenas uma vez por atendimento.

## Comandos

| Comando | O que faz |
| --- | --- |
| `/entrar` | entra na fila |
| `/sair` | sai da fila |
| `/posicao` | mostra posição, tempo de espera e previsão |
| `/protocolo` | consulta seu protocolo mais recente (ou `/protocolo numero:12`) |
| `/ajuda` | resumo das regras e horários |

## Quando a central está fechada

O botão recusa novas entradas e informa o próximo horário de abertura. Atendimentos já iniciados
continuam normalmente. Confira os horários no painel ou em `/ajuda`.

## Boas práticas

- Fique no canal de espera até ser chamado — sair dele encerra sua posição.
- Não abra protocolo sem necessidade real; cada entrada fica registrada no histórico.
- Mantenha as mensagens privadas abertas para receber as notificações.
