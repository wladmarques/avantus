'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');
const { formatDuration } = require('../../utils/time');

const PERIODS = [
  { name: 'Hoje', value: 'hoje' },
  { name: 'Últimos 7 dias', value: '7d' },
  { name: 'Últimos 30 dias', value: '30d' },
  { name: 'Mês atual', value: 'mes' },
  { name: 'Todo o período', value: 'total' },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('estatisticas')
    .setDescription('Relatórios de desempenho da central e da equipe')
    .addStringOption((option) =>
      option.setName('periodo').setDescription('Período do relatório').addChoices(...PERIODS).setRequired(false),
    ),
  async execute({ interaction, services }) {
    const period = interaction.options.getString('periodo') || 'hoje';
    try {
      const summary = services.statistics.summary(interaction.guildId, period);
      const formatted = services.statistics.formatSummary(summary);

      const ranking =
        summary.ranking.length === 0
          ? '_Sem dados suficientes._'
          : summary.ranking
              .slice(0, 10)
              .map(
                (entry, index) =>
                  `**${index + 1}.** <@${entry.staffId}> — ${entry.concluded} atendimento(s)${
                    entry.avgRating ? ` • ⭐ ${entry.avgRating.toFixed(2)}/4` : ''
                  }${entry.avgDurationSeconds ? ` • ⏱️ ${formatDuration(entry.avgDurationSeconds)}` : ''}${
                    entry.eligible ? '' : ' _(amostra pequena)_'
                  }`,
              )
              .join('\n');

      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: `📈 Relatório — ${summary.range.label}`,
              description: [
                `**Atendimentos encerrados:** ${summary.total}`,
                `**Concluídos:** ${summary.concluded}`,
                `**Espera média:** ${formatted.avgWait} • **Maior espera:** ${formatted.maxWait}`,
                `**Duração média:** ${formatted.avgDuration}`,
                `**Avaliação média:** ${formatted.rating}`,
                `**Horários de pico:** ${formatted.peakHours}`,
                '',
                '**Resultados**',
                formatted.outcomes,
              ].join('\n'),
              color: COLORS.PURPLE,
              fields: [
                { name: '🏆 Ranking da equipe', value: ranking },
                { name: '⭐ Avaliações', value: formatted.distribution },
              ],
              footer: 'Ranking = volume concluído + avaliação (até 20%). Atendimentos longos não são penalizados.',
            }),
          ],
        }),
      );
    } catch (error) {
      return respondError(interaction, error);
    }
  },
};
