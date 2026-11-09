'use strict';

/**
 * Painel público da central.
 *
 * Layout `modern` (Components V2): um único container escuro com barra de
 * destaque laranja, cabeçalho compacto, bloco de status, indicadores, faixa de
 * horário e rodapé com o botão "Entrar na Fila" à direita.
 *
 * Limitação da API do Discord: containers não podem ser aninhados nem
 * organizados em colunas — por isso os 4 indicadores aparecem em uma linha
 * compacta em vez de 4 cards lado a lado (o layout de referência completo está
 * disponível em `npm run preview:panel`).
 *
 * Layout `classic`: embed tradicional (fallback automático).
 *
 * Tudo em JSON puro: os payloads podem ser testados sem conexão com o Discord.
 */
const path = require('node:path');
const { COLORS, BRAND } = require('../../config/theme');
const { publicPanelComponents } = require('../components/buttons');
const { formatDuration, formatTime, DAY_KEYS } = require('../../utils/time');

/** MessageFlags.IsComponentsV2 */
const COMPONENTS_V2_FLAG = 32768;

const text = (content) => ({ type: 10, content });
const separator = (spacing = 1, divider = true) => ({ type: 14, divider, spacing });
/** Container. Sem `accent_color` ele vira uma caixa neutra, sem barra lateral. */
const card = (accentColor, components) => ({
  type: 17,
  ...(accentColor == null ? {} : { accent_color: accentColor }),
  components,
});
/** Section: texto à esquerda e UM acessório (botão ou imagem) à direita. */
const section = (components, accessory) => ({ type: 9, components, accessory });
const thumbnail = (url, description) => ({ type: 11, media: { url }, description });

/**
 * Artes do relógio (geradas por `npm run art`, em `assets/`).
 *
 * É isso que dá o "relógio grande" da referência: no Components V2 a seção
 * aceita uma imagem como acessório, exibida à direita do texto — o equivalente
 * ao thumbnail de um embed, porém grande e com a arte no tamanho original.
 */
const ART_DIR = path.join(__dirname, '..', '..', '..', 'assets');
const ART = {
  fechada: { file: 'central-fechada.png', description: 'Relógio vermelho: fora do horário de atendimento' },
  semStaff: { file: 'central-sem-staff.png', description: 'Relógio âmbar: central aberta, sem staff disponível' },
  disponivel: { file: 'central-disponivel.png', description: 'Relógio verde: equipe disponível para atender' },
};

/** Arte do estado atual da central. */
function statusArt({ open, availableStaff }) {
  if (!open) return ART.fechada;
  if (availableStaff > 0) return ART.disponivel;
  return ART.semStaff;
}

/** Nome do arquivo enviado junto com a mensagem (`attachment://`). */
function statusArtPath(art) {
  return path.join(ART_DIR, art.file);
}
const button = (customId, label, style, emoji, disabled = false) => ({
  type: 2,
  style,
  custom_id: customId,
  label,
  disabled,
  ...(emoji ? { emoji: { name: emoji } } : {}),
});

const DAY_SHORT = { mon: 'Seg', tue: 'Ter', wed: 'Qua', thu: 'Qui', fri: 'Sex', sat: 'Sáb', sun: 'Dom' };

/** Ícone do cabeçalho: usa o do título quando já existe, senão adiciona o headset. */
function titleWithIcon(title) {
  const value = String(title || BRAND.title).trim();
  // Mantém o emoji do título quando ele já começa com um.
  const startsWithEmoji = /^[\p{Extended_Pictographic}]/u.test(value);
  return startsWithEmoji ? value : `🎧 ${value}`;
}

/** Agrupa dias consecutivos com o mesmo horário: "Seg–Sex: 12:00 às 02:00". */
function describeScheduleCompact(schedule) {
  if (!schedule || typeof schedule !== 'object') return ['Não configurado'];

  const groups = [];
  let current = null;
  for (const key of DAY_KEYS.slice(1).concat(DAY_KEYS[0])) {
    const windows = Array.isArray(schedule[key]) ? schedule[key] : [];
    const label = windows.length
      ? windows.map((window) => `${window.open} às ${window.close}`).join(' / ')
      : 'fechado';
    if (current && current.label === label) current.days.push(key);
    else {
      current = { label, days: [key] };
      groups.push(current);
    }
  }

  return groups.map((group) => {
    const days = group.days;
    const first = DAY_SHORT[days[0]];
    const last = DAY_SHORT[days[days.length - 1]];
    const range = days.length === 1 ? first : `${first}–${last}`;
    return { range, label: group.label };
  });
}

/**
 * Estado da central: manchete curta + nota de apoio.
 *
 * A manchete é **só o estado**, sem repetir "ATENDIMENTO": o título da caixa
 * já diz `ATENDIMENTO | VANTUS`, então "ATENDIMENTO DISPONÍVEL" logo abaixo
 * repetia a palavra duas vezes na mesma caixa. Pelo mesmo motivo a nota não
 * repete o estado ("Central fechada" embaixo de "FORA DO HORÁRIO").
 *
 * @returns {{indicator: string, headline: string, note: string}}
 */
function statusInfo({ open, availableStaff, nextOpen, manual = false }) {
  if (!open) {
    // Fechada pela administração não é "fora do horário": o painel precisa
    // dizer qual dos dois é, senão o jogador espera a hora passar à toa.
    return {
      indicator: '🔴',
      headline: manual ? 'CENTRAL FECHADA' : 'FORA DO HORÁRIO',
      note: manual
        ? 'Fechada pela administração'
        : nextOpen
          ? `Reabre ${nextOpen}`
          : 'Confira o horário de atendimento',
    };
  }
  if (availableStaff > 0) {
    return {
      indicator: '🟢',
      headline: 'DISPONÍVEL',
      note:
        availableStaff === 1
          ? '1 staff pronto para atender'
          : `${availableStaff} staffs prontos para atender`,
    };
  }
  return {
    indicator: '🟡',
    headline: 'AGUARDANDO STAFF',
    note: 'Fila aberta • nenhum staff em serviço',
  };
}

/**
 * Layout moderno (Components V2).
 * @returns {{payload: object, format: 'v2'}}
 */
function buildPublicPanelV2({ settings, state, schedule, now = new Date() }) {
  const open = schedule.open;
  const available = state.staffCounts.DISPONIVEL ?? 0;
  const status = statusInfo({
    open,
    availableStaff: available,
    nextOpen: schedule.nextOpen,
    manual: schedule.manual,
  });
  // Entrar na fila só é possível com a central aberta E com staff disponível.
  const canJoin = Boolean(open) && available > 0;
  const unavailableNote = !open
    ? schedule.nextOpen
      ? `central fechada • reabre ${schedule.nextOpen}`
      : 'central fechada'
    : 'sem staff em serviço';

  // A entrada na fila exige estar no canal de voz de espera.
  const waitChannel = settings.wait_channel_id
    ? `Entre em <#${settings.wait_channel_id}> e clique no botão para entrar na fila. `
    : 'Entre no canal de voz de espera e clique no botão para entrar na fila. ';
  const exitNote = 'Sair da espera remove você da fila.';

  const scheduleLines = describeScheduleCompact(schedule.schedule)
    .slice(0, 3)
    .map((entry) => `-# ${entry.range}: ${entry.label}`);

  const art = statusArt({ open, availableStaff: available });

  /**
   * Caixa de indicador: rótulo pequeno em cima, número grande embaixo.
   *
   * A referência mostra os quatro indicadores lado a lado; a API do Discord não
   * tem colunas (containers não podem ser aninhados nem dividir a linha), então
   * os três ficam **no mesmo bloco**, um abaixo do outro — é o mais próximo
   * possível de "um agrupamento de indicadores" em vez de três caixas soltas.
   */
  const metric = (label, value) => text([`-# ${label}`, `# ${value}`].join('\n'));

  const components = [
    // Caixa de status: título, estado (com o relógio à direita) e a nota.
    card(open && available > 0 ? COLORS.SUCCESS : open ? COLORS.WARNING : COLORS.ACCENT, [
      text(`## ${titleWithIcon(settings.message_panel_title)}`),
      // Título grande, estado em destaque e a nota de apoio — sem rótulo
      // intermediário, que só repetia o que a manchete já diz.
      section(
        [text(`# ${status.headline}`), text(`-# ${status.note}`)],
        thumbnail(`attachment://${art.file}`, art.description),
      ),
    ]),

    // Corpo: indicadores e horário no mesmo bloco (fechada, só o horário).
    card(null, [
      ...(open
        ? [
            metric('NA FILA', state.waiting.length),
            metric('STAFFS DISPONÍVEIS', available),
            metric('EM ANDAMENTO', state.serving.length),
            separator(1),
          ]
        : []),
      text(['-# **HORÁRIO DE ATENDIMENTO**', ...scheduleLines].join('\n')),
    ]),

    // Rodapé: texto à esquerda, botão à direita.
    card(COLORS.ACCENT, [
      section(
        [
          text('**🎧 Fila por canal de voz**'),
          text(
            `-# ${waitChannel}Você será movido automaticamente quando houver staff disponível. ${exitNote}`,
          ),
        ],
        button('pub:join', 'Entrar na Fila', 2, '🎟️', !canJoin),
      ),
      text(
        canJoin
          ? '-# Só é possível entrar na fila estando no canal de voz de espera. `/sair` desiste da fila e `/posicao` mostra a sua posição.'
          : `-# Entrada na fila indisponível: ${unavailableNote}.`,
      ),
      // Avaliação sempre acessível (mesmo com a DM fechada)
      {
        type: 1,
        components: [button('pub:evaluate', 'Avaliar atendimento', 2)],
      },
    ]),
  ];

  return {
    format: 'v2',
    payload: {
      flags: COMPONENTS_V2_FLAG,
      components,
      // A arte viaja junto com a mensagem (`attachment://`). Precisa ser
      // reenviada a cada edição, senão o Discord remove o anexo.
      files: [statusArtPath(art)],
    },
  };
}

/**
 * Layout clássico (embed) — fallback.
 * @returns {{payload: object, format: 'embed'}}
 */
function buildPublicPanelClassic({
  settings,
  state,
  schedule,
  todayWindow,
  now = new Date(),
  refreshSeconds = 30,
}) {
  const open = schedule.open;
  const available = state.staffCounts.DISPONIVEL ?? 0;
  const status = statusInfo({
    open,
    availableStaff: available,
    nextOpen: schedule.nextOpen,
    manual: schedule.manual,
  });

  const fields = [
    { name: 'STATUS DA CENTRAL', value: `${status.indicator} ${status.headline}`, inline: false },
    { name: 'NA FILA', value: `**${state.waiting.length}**`, inline: true },
    { name: 'STAFFS DISPONÍVEIS', value: `**${available}**`, inline: true },
    { name: 'EM ANDAMENTO', value: `**${state.serving.length}**`, inline: true },
    { name: 'HORÁRIO DE ATENDIMENTO', value: `**${todayWindow?.text ?? '—'}**`, inline: false },
  ];

  const art = statusArt({ open, availableStaff: available });

  const embed = {
    color: open ? COLORS.ACCENT : COLORS.MUTED,
    title: titleWithIcon(settings.message_panel_title),
    description: open ? null : `🔒 ${status.note}`,
    // Mesma arte do layout moderno, agora como thumbnail do embed.
    thumbnail: { url: `attachment://${art.file}` },
    fields,
    // O `timestamp` logo abaixo já mostra a hora: repetir "Atualizado 11:07" no
    // texto do rodapé só duplicava a informação.
    footer: { text: `Central de Atendimento • atualiza a cada ${refreshSeconds}s` },
    timestamp: now.toISOString(),
  };

  const canJoin = Boolean(open) && available > 0;
  return {
    format: 'embed',
    payload: {
      embeds: [embed],
      components: publicPanelComponents({ joinDisabled: !canJoin }),
      files: [statusArtPath(art)],
    },
  };
}

/**
 * Escolhe o layout conforme a configuração (com fallback automático).
 * @param {'modern'|'classic'} style
 */
function buildPublicPanel(context) {
  const style = context.style === 'classic' ? 'classic' : 'modern';
  return style === 'classic' ? buildPublicPanelClassic(context) : buildPublicPanelV2(context);
}

module.exports = {
  COMPONENTS_V2_FLAG,
  ART,
  ART_DIR,
  statusArt,
  statusArtPath,
  buildPublicPanel,
  buildPublicPanelV2,
  buildPublicPanelClassic,
  describeScheduleCompact,
  statusInfo,
  titleWithIcon,
};
