# 03 • Permissões e intents do bot

## Intents necessários

| Intent | Por quê | Privilegiada |
| --- | --- | --- |
| `GUILDS` | canais, cargos e eventos básicos | não |
| `GUILD_MEMBERS` | cargos do staff, entrada/saída de membros | **sim** (ativar no portal) |
| `GUILD_VOICE_STATES` | mover jogadores, presença nos canais | não |

Nenhum intent de mensagens é solicitado — o bot não lê conteúdo de conversas.

## Permissões do bot

| Permissão | Uso |
| --- | --- |
| View Channels | ver os canais configurados |
| Send Messages | publicar painéis, logs e avisos |
| Embed Links | embeds dos painéis |
| Read Message History | editar as mensagens persistentes |
| Connect | acompanhar canais de voz (quando necessário) |
| Move Members | mover jogador para a espera/atendimento e desconectar |
| Manage Channels | criar canais no `/setup` |
| Manage Roles | criar/editar os *overwrites* de acesso por atendimento |

Valor numérico das permissões acima: `286346256`.

> O botão **desconectar** e a liberação de acesso por atendimento dependem de **Mover membros**
> e **Gerenciar cargos**. Se o cargo do bot estiver abaixo do cargo do staff na hierarquia,
> a movimentação falha com `Missing Permissions`.

## Hierarquia de cargos

1. O cargo do bot deve estar **acima** dos cargos dos jogadores (para movê-los).
2. Para mover staffs, o cargo do bot precisa estar acima do cargo do staff.
3. Nunca dê **Administrador** ao bot: as permissões acima são suficientes.

## Permissões por canal

- **Painéis** (`central-atendimento`, `painel-staff`): o bot precisa de *Ver canal*, *Enviar mensagens*,
  *Inserir links* e *Ler histórico*. No canal da staff, restrinja *Ver canal* aos cargos de equipe.
- **Canal de espera** (`⏳・aguardando-atendimento`): permita *Conectar* para `@everyone`.
- **Canais de atendimento**: negue *Conectar* para `@everyone`; o bot libera o acesso individual
  quando chama o jogador e revoga ao finalizar.
- **Canal de logs**: restrinja a leitura aos cargos administrativos.

## Verificação rápida

```
/diagnostico
```

O comando valida canais, tipos, cargos, permissões do bot e painéis publicados, apontando exatamente
o que está faltando.

## Erros comuns

| Erro | Causa | Solução |
| --- | --- | --- |
| `Missing Permissions` ao mover | bot abaixo do membro na hierarquia | suba o cargo do bot |
| `Missing Access` | canal sem permissão para o bot | libere *Ver canal* para o bot |
| Não é possível editar o painel | mensagem apagada | `/painel reconstruir painel:Público` |
| Não envia DM | usuário com DMs fechadas | o bot registra no log e segue (não bloqueia a fila) |
