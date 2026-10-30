'use strict';

const { COLORS, BRAND } = require('../../config/theme');
const { publicPanelComponents } = require('../components/buttons');
const { formatDuration, formatTime } = require('../../utils/time');

/**
 * Painel público — atualizado automaticamente a cada mudança de estado.
 */
function buildPublicPanel({ settings, state, schedule, now = new Date() }) {
  const open = schedule.open;
  const today = schedule.todayWindow ?? { text: '—' };
  const estimate = settings.estimateWaitSeconds ?? 0;

  const statusField = open ? '🟢 **ABERTA**' : '📕 **FECHADA**';
  const fields = [
    { name: '📊 STATUS DA CENTRAL', value: statusField, inline: true },
    { name: '🎫 NA FILA', value: `**${state.waiting.length}** jogador(es)`, inline: true },
    { name: '🛡️ STAFFS DISPONÍVEIS', value: `**${state.staffCounts.DISPONIVEL}** em serviço`, inline: true },
    { name: '📞 EM ATENDIMENTO', value: `**${state.serving.length}** ativo(s)`, inline: true },
    { name: '⏳ ESPERA MÉDIA', value: `**${formatDuration(estimate)}**`, inline: true },
    { name: '⏰ HORÁRIO DE ATENDIMENTO', value: `**${today.text}**`, inline: true },
  ];

  const embed = {
    color: open ? COLORS.ORANGE : COLORS.MUTED,
    title: settings.message_panel_title || BRAND.title,
    description: [
      settings.message_panel_description,
      open
        ? null
        : `\n🔒 **Central fechada**${schedule.nextOpen ? ` • reabre ${schedule.nextOpen}` : ''}`,
    ]
      .filter(Boolean)
      .join('\n'),
    fields,
    footer: {
      text: `${BRAND.footer} • Atualizado ${formatTime(now)} • Atualização automática`,
    },
    timestamp: now.toISOString(),
  };

  return { embeds: [embed], components: publicPanelComponents() };
}

module.exports = { buildPublicPanel };
