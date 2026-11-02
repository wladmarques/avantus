'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS, RATING_META } = require('../../config/theme');
const { formatDateTime } = require('../../utils/time');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('avaliacoes')
    .setDescription('Consulta as avaliações dos atendimentos')
    .addStringOption((option) =>
      option
        .setName('periodo')
        .setDescription('Período')
        .setRequired(false)
        .addChoices(
          { name: 'Hoje', value: 'hoje' },
          { name: 'Últimos 7 dias', value: '7d' },
          { name: 'Últimos 30 dias', value: '30d' },
          { name: 'Todo o período', value: 'total' },
        ),
    ),
  async execute({ interaction, services }) {
    const period = interaction.options.getString('periodo') || '30d';
    try {
      const summary = services.evaluations.summary(interaction.guildId, period);
      const distribution = Object.entries(RATING_META)
        .map(([key, meta]) => `${meta.emoji} ${meta.label}: **${summary.byRating[key] ?? 0}**`)
        .join('\n');

      const byStaff =
        summary.byStaff.length === 0
          ? '_Sem dados._'
          : summary.byStaff
              .map(
                (entry) =>
                  `<@${entry.staff_id}> — ${entry.total} avaliação(ões) • média **${Number(
                    entry.avg_score,
                  ).toFixed(2)}/4**`,
              )
              .join('\n');

      const recent =
        summary.recent.length === 0
          ? '_Nenhuma avaliação no período._'
          : summary.recent
              .slice(0, 8)
              .map(
                (entry) =>
                  `⭐ **${RATING_META[entry.rating]?.label ?? entry.rating}** — \`#${String(
                    entry.protocol,
                  ).padStart(4, '0')}\` • ${formatDateTime(new Date(entry.created_at))}`,
              )
              .join('\n');

      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: `⭐ Avaliações — ${summary.range.label}`,
              description: `**Total:** ${summary.total} avaliação(ões)`,
              color: COLORS.ORANGE,
              fields: [
                { name: 'Distribuição', value: distribution, inline: true },
                { name: 'Por staff', value: byStaff, inline: true },
                { name: 'Últimas', value: recent },
              ],
            }),
          ],
        }),
      );
    } catch (error) {
      return respondError(interaction, error);
    }
  },
};
