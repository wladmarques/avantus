# Banco de horas da equipe

Controle de jornada dos staffs: escala semanal, contagem automática das horas em serviço,
aviso por DM antes do turno e relatórios completos em um painel web.

## Como funciona

| Momento | O que acontece |
| --- | --- |
| O staff fica **DISPONÍVEL** (`/status`, painel da equipe ou entrando no canal de atendimento) | a sessão de trabalho **abre** e as horas começam a contar |
| O staff entra **EM ATENDIMENTO** | a sessão **continua** aberta (ele segue em serviço) |
| O staff fica **AUSENTE / INDISPONÍVEL** ou sai do canal | a sessão **fecha** e as horas são gravadas |
| Faltam **5 minutos** para o turno cadastrado | o bot envia uma **DM de aviso** (uma única vez por turno/dia) |
| A sessão passa de `hour_bank_max_session_hours` (padrão 12h) | é fechada automaticamente (proteção contra queda do bot) |

**Atraso** = diferença entre a entrada real e o início do turno cadastrado (nos fins de semana
revezados, só conta para quem está escalado naquele fim de semana).
**Saída antecipada** = diferença entre o fim do turno e a saída real.

Nada disso é manual: os números vêm do próprio status do staff, que já é atualizado
automaticamente pelo painel, pelos comandos e pelos eventos de voz.

## Painel web

O painel é servido pelo **mesmo processo do bot** (Node HTTP nativo, sem dependências novas).

### Configuração

```bash
# .env
WEB_PANEL_PASSWORD=uma-senha-forte      # obrigatória: sem ela o painel fica desligado
WEB_PANEL_PORT=8080                     # SquareCloud (site): use 80
WEB_PANEL_HOST=0.0.0.0
```

- **Local:** `http://localhost:8080` → senha → pronto.
- **SquareCloud:** o painel só é acessível pela internet se o app estiver configurado como
  **Site** (a SquareCloud expõe a porta 80). Nesse caso use `WEB_PANEL_PORT=80`.
  Se preferir apenas o bot, deixe `WEB_PANEL_PASSWORD` vazio — o painel não sobe e o bot
  funciona normalmente.

### O que aparece

- **Cartões**: staff cadastrados, quem está em serviço agora, horas no período e atrasos.
- **Tabela da equipe**: nome, status atual (ou *EM SERVIÇO desde HH:MM*), turno de hoje,
  entrada, saída, horas do período e atrasos acumulados.
- **Escala cadastrada**: resumo semanal de cada staff.
- **Sessões** (clique na linha): cada entrada/saída do período, com etiqueta de
  *EM SERVIÇO*, *ATRASO n min* ou *NO HORÁRIO*.
- **Período**: hoje, 7 dias, 30 dias ou intervalo personalizado.
- **CSV**: exporta o relatório do período (horas, sessões, entrada, saída, atrasos).

### Escala no canal (webhook)

O painel publica a **escala da semana** (segunda a domingo) no canal do webhook informado.

1. No Discord: canal → **Editar canal** → **Integrações** → **Webhooks** → **Novo webhook** →
   **Copiar URL do webhook**.
2. No painel, em **Escala no canal**, cole a URL e clique em **Salvar**.
3. Clique em **Enviar escala agora** — a mensagem é publicada na hora.

Como a mensagem é montada (sem emojis, paleta VANTUS):

```
ESCALA DA SEMANA
26/10 a 01/11 · fim de semana A
Horários no fuso do bot. Turnos com "+1 dia" terminam no dia seguinte.

Segunda a sexta · 26/10–30/10
Conde — 11:00–15:00
Rafael Kavallieri 0303 — 11:00–15:00

Sábado e domingo · 31/10 e 01/11
Conde — 11:00–13:00
VANTUS • Banco de horas
```

- embed com barra vermelha `#ff2200` e título `ESCALA DA SEMANA`;
- a descrição mostra a semana e o **grupo do fim de semana** (`· fim de semana A`);
- **dias com a mesma escala viram um bloco só** — como os dias úteis são idênticos, a semana
  inteira costuma caber em duas seções (`Segunda a sexta · 26/10–30/10` e
  `Sábado e domingo · 31/10 e 01/11`) em vez de sete colunas repetidas;
- cada staff aparece **uma vez por bloco**, com os turnos encadeados resumidos:
  `11:00–13:00` + `13:00–15:00` → `11:00–15:00`;
- campos em largura cheia (nada de três colunas apertadas quebrando o nome);
- staffs ordenados pelo horário de início (e pelo nome em caso de empate);
- nos fins de semana só entram os staffs do **grupo daquela semana**;
- dias sem ninguém escalado não aparecem; semana vazia mostra *Ninguém escalado nesta semana.*;
- ninguém é mencionado/pingado (`allowed_mentions.parse` vazio).

O webhook fica salvo na configuração `hour_bank_webhook_url` (tabela `settings`) e só é
aceito no formato do Discord — para remover, apague o campo e salve (isso também desliga o
envio automático).

#### Envio automático

No mesmo painel, marque **Enviar automaticamente**, escolha o **dia da semana** e o **horário**
e clique em **Salvar**. Regras:

- o envio acontece **uma vez por semana**, no dia/horário escolhidos (padrão: segunda, 09:00);
- se o bot estiver desligado na hora exata, a escala é publicada **assim que ele voltar no
  mesmo dia** (não fica esperando a semana seguinte);
- reiniciar o bot **não duplica** a mensagem: a semana publicada fica gravada em
  `hour_bank_webhook_last_week`;
- **Enviar escala agora** também marca a semana como publicada — o automático não repete;
- se o webhook recusar a mensagem, a semana **não** é marcada e o bot tenta de novo a cada
  minuto (o erro aparece no log `hourbank`).

Configurações relacionadas (também editáveis por `/config`):

| Chave | Padrão | Para que serve |
| --- | --- | --- |
| `hour_bank_webhook_url` | *(vazio)* | URL do webhook do canal |
| `hour_bank_webhook_auto` | `false` | liga o envio automático |
| `hour_bank_webhook_day` | `1` | dia do envio (0 = domingo … 6 = sábado) |
| `hour_bank_webhook_time` | `09:00` | horário do envio (HH:MM) |
| `hour_bank_webhook_last_week` | — | última semana publicada (controle interno) |

> Para testar sem postar em um canal real, rode o receptor local e suba o preview apontando
> para ele: `node scripts/dev-webhook-sink.js` em um terminal e, no outro,
> `PREVIEW_WEBHOOK_URL=http://127.0.0.1:8099/hook npm run preview:web`.

### Nome do staff

Cada staff aparece pelo **nome cadastrado**. A ordem usada pelo painel é:

1. nome definido manualmente no painel (**Nome** / **Definir nome** na linha do staff);
2. nome guardado de uma resolução anterior;
3. nome do membro no servidor (resolvido automaticamente pela API do Discord);
4. nome que ficou registrado na escala ou nas sessões;
5. se nada existir: `Usuário <id>`.

O botão **Usar nome do Discord** remove o nome manual e deixa o painel voltar a usar o nome do
membro. O nome manual **nunca** é sobrescrito pela resolução automática. Tudo fica na tabela
`staff_names` (migração v6), então sobrevive a reinícios.

> O nome do Discord é resolvido no primeiro carregamento do painel e guardado — se o bot estiver
> offline (sem conexão com o Discord), o painel mantém o último nome conhecido.

### Cadastrar a escala

A escala tem **dois blocos** — não é preciso cadastrar dia por dia.

1. Clique em **Editar escala** na linha do staff.
2. **Dias úteis**: marque a caixa e informe **um único horário** — ele vale de segunda a sexta.
3. **Fim de semana**: marque a caixa, informe o horário e escolha o **revezamento**:
   - **Fim de semana A** ou **Fim de semana B** — os grupos se alternam: quem trabalha em um
     fim de semana folga no próximo;
   - **Todos os fins de semana** — o staff trabalha todo sábado e domingo.
4. **Salvar escala** — o bot passa a usar a nova escala imediatamente.

O modal mostra ainda qual grupo é o **desta semana** e se o staff trabalha ou folga, e o
cabeçalho de *Escala cadastrada* repete essa informação. Turnos que cruzam a meia-noite são
aceitos (`22:00` → `02:00`) e, no fim de semana, valem para **sábado e domingo**.

> O revezamento é semanal: cada semana do calendário (segunda a domingo) pertence ao grupo A ou
> B, alternando sempre. Um staff do grupo A só tem turno previsto nos fins de semana A — nos
> fins de semana B ele não conta atraso/saída antecipada, não recebe DM de aviso e não aparece
> na escala daquela semana no webhook. O mesmo vale para o grupo B.

Pelo Discord, `/banco escala` aceita o parâmetro opcional **grupo** (`A`, `B` ou *todos*) para
os dias de sábado/domingo; nos dias úteis ele só cadastra o turno daquele dia.

> O staff aparece no painel assim que tem **nome**, escala cadastrada ou status registrado.
> Para cadastrar alguém novo, use `/banco escala` uma vez com o membro ou defina o nome pelo
> painel no botão **Definir nome** da linha dele.

### API (mesma origem, exige sessão)

| Método | Rota | Descrição |
| --- | --- | --- |
| POST | `/api/login` | `{ "password": "..." }` → cookie `vantus_session` (HttpOnly, SameSite=Strict, 12h) |
| POST | `/api/logout` | encerra a sessão |
| GET | `/api/overview?from&to` | staff + status + escala + horas |
| GET | `/api/report?from&to` | relatório agregado por staff |
| GET | `/api/sessions?userId&from&to` | sessões detalhadas |
| PUT | `/api/staff/:userId/shifts` | `{ staffName, shifts: [{ weekday, start, end, parity? }] }` — `parity` = `A`/`B` para fim de semana revezado |
| PUT | `/api/staff/:userId/name` | `{ staffName }` — define o nome exibido (`""` volta ao nome do Discord) |
| GET | `/api/schedule/webhook` | webhook + envio automático (`{ url, configured, auto, day, dayLabel, time, lastWeek }`) |
| PUT | `/api/schedule/webhook` | `{ url, auto, day, time }` — campos omitidos são mantidos (`url: ""` remove e desliga o automático) |
| POST | `/api/schedule/send` | publica a escala da semana no webhook |
| DELETE | `/api/staff/:userId/shifts` | remove a escala |
| GET | `/api/health` | verificação de disponibilidade |

Proteções: senha comparada em tempo constante, limite de 8 tentativas por IP a cada 5 minutos,
cookie `HttpOnly` (`SameSite=Lax` em HTTP, `SameSite=None; Secure` quando acessado por HTTPS/proxy),
`Cache-Control: no-store` nas respostas da API.

### Acesso dentro de iframe / proxy (preview)

Em iframes de terceiros o navegador bloqueia **cookies** e **sessionStorage**, o que derrubava o
login com "Sessão expirada" logo após autenticar. O painel resolve isso em camadas:

| Camada | Quando é usada |
| --- | --- |
| Token em memória | sempre (mesma aba, enquanto a página estiver aberta) |
| `sessionStorage` | navegador normal (com storage liberado) |
| Token assinado no **hash da URL** (`#auth=…`) | quando o storage está bloqueado — sobrevive ao reload |

O token é **assinado com HMAC** derivado da senha (`WEB_PANEL_PASSWORD`), então continua válido
mesmo que o processo reinicie — e passa a ser inválido se a senha mudar. A autenticação chega ao
servidor por `Authorization: Bearer`, por `?auth=` ou por cookie (`SameSite=None; Secure` em HTTPS).
O logout revoga o token imediatamente.

O painel também é servido sem `X-Frame-Options` e com `Content-Security-Policy: frame-ancestors *`,
e os assets saem com `no-store` + versão (`app.js?v=…`, `styles.css?v=…`) para nunca rodar um JS ou
CSS antigo em cache. A versão é o hash dos três arquivos de `src/web/public`.

> Como o token pode ir no hash da URL em modo de contingência, evite compartilhar o link do painel
> enquanto estiver logado; ao sair (**Sair**) ele é removido.

## Comandos no Discord

```bash
/banco ver                       # suas horas, escala, atrasos e próximo turno
/banco staff membro:@fulano      # banco de horas de um membro da equipe
/banco equipe                    # resumo dos últimos 7 dias (admin)
/banco escala membro:@fulano dia:Segunda inicio:12:00 fim:18:00   # adiciona um turno (admin)
/banco limpar membro:@fulano     # remove a escala (admin)
```

## Configurações

| Chave | Padrão | Descrição |
| --- | --- | --- |
| `hour_bank_enabled` | `true` | Liga/desliga a contagem automática |
| `hour_bank_reminder_minutes` | `5` | Antecedência do aviso por DM (`0` desliga) |
| `hour_bank_max_session_hours` | `12` | Limite para fechamento automático da sessão |

```bash
/config definir chave:hour_bank_reminder_minutes valor:10
/config definir chave:hour_bank_enabled valor:false
```

## Prévia local com dados de exemplo

```bash
npm run preview:web     # http://localhost:8080 • senha: vantus
```

O script usa um banco separado (`data/preview-web.sqlite`) — nenhum dado real é tocado.

## Problemas comuns

| Sintoma | Causa / solução |
| --- | --- |
| Não conta horas | staff precisa estar **DISPONÍVEL** (ou em atendimento); confira `/banco ver` |
| Staff não aparece no fim de semana | ele está no outro grupo do revezamento (A/B) — confira o grupo na **Escala cadastrada** |
| DM de aviso não chega | staff com DM fechada; `hour_bank_reminder_minutes` igual a `0`; turno cadastrado para outro dia |
| Atraso zerado | o staff entrou **antes** ou exatamente no início do turno, ou não havia turno naquele horário |
| Painel não abre | `WEB_PANEL_PASSWORD` vazio (painel desligado) ou porta bloqueada — veja o log `web` do bot |
| Tela em branco no preview/iframe | era bloqueio de `X-Frame-Options` — corrigido; se persistir, rode `LOG_LEVEL=debug` e confira `GET /` no log |
| Login "não aceita" e volta para a tela de senha | corrigido: token assinado em memória/hash, aceito via header, query ou cookie. Se aparecer, clique em **Recarregar** na própria tela (limpa cache do JS antigo) |
| Entra, mas a tela de senha **continua na frente** do painel | era CSS: `.login { display: grid }` vencia o atributo `hidden`. Corrigido com `[hidden] { display: none !important }`; há teste de regressão do CSS |
| Mensagem "unauthorized" ao errar a senha | corrigido: o login mostra o texto do servidor (**Senha incorreta.**) e o botão fica em "Entrando…" durante a requisição |
| Escala automática não chegou | `hour_bank_webhook_auto` desligado, webhook vazio, ou o dia/horário escolhido ainda não chegou — confira o painel e o log `hourbank` |
| Webhook recusa a escala | URL copiada incompleta, webhook apagado/canal sem permissão ou mensagem enviada por outro bot — confira a mensagem do painel (HTTP 400/404) |
| Horas erradas após queda do bot | a sessão é fechada no limite de `hour_bank_max_session_hours`; ajuste manualmente a escala/horário pelo painel |

## Log do painel

Cada requisição é registrada com escopo `web`:

```
[DEBUG] [web] GET / → 200 (2ms)
[DEBUG] [web] GET /api/overview → 200 (3ms)
[WARN]  [web] GET /api/overview → 401 (0ms)     ← sem sessão (normal antes do login)
[ERROR] [web] GET /api/overview → 500 (12ms)    ← erro real, com stack no log
```

Para ver tudo: `LOG_LEVEL=debug npm start` (ou `LOG_LEVEL=debug npm run preview:web`).

## Estrutura no código

| Arquivo | Responsabilidade |
| --- | --- |
| `src/systems/hourbank/hourBankService.js` | sessões, atrasos, relatórios, avisos |
| `src/systems/hourbank/shiftSchedule.js` | escala semanal, turnos que viram o dia, próximas ocorrências |
| `src/database/repositories/hourBankRepository.js` | persistência (escala, sessões, avisos) |
| `src/web/server.js` | HTTP, autenticação e API |
| `src/web/public/*` | interface (HTML/CSS/JS, sem build) |
| `src/commands/staff/banco.js` | `/banco ...` |
| migração **v5 `banco_de_horas`** | tabelas `staff_shifts`, `staff_sessions`, `staff_shift_reminders` |
