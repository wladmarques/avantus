'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');
const { formatDuration } = require('../../utils/time');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('finalizar')
    .setDescription('Finaliza o seu atendimento em andamento')
    .addStringOption((option) =>
      option
        .setName('observacao')
        .setDescription('Observação para o histórico do atendimento')
        .setMaxLength(400)
        .setRequired(false),
    ),
  async execute({ interaction, services }) {
    try {
      const closed = await services.attendance.finishByStaff({
        guildId: interaction.guildId,
        staffId: interaction.user.id,
        staffTag: interaction.member.displayName,
        note: interaction.options.getString('observacao'),
      });
      await services.panels.refresh(interaction.guildId).catch(() => null);
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '✅ Atendimento finalizado',
              description: [
                `**Jogador:** <@${closed.user_id}>`,
                `**Protocolo:** \`#${String(closed.protocol).padStart(4, '0')}\``,
                `**Duração:** ${formatDuration(closed.duration_seconds)}`,
              ].join('\n'),
              color: COLORS.SUCCESS,
            }),
          ],
        }),
      );
    } catch (error) {
      return respondError(interaction, error);
    }
  },
};
