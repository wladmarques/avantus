'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sair')
    .setDescription('Sai da fila de atendimento'),
  async execute({ interaction, services }) {
    await interaction.deferReply({ flags: 64 });
    try {
      const closed = await services.queue.leave({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        reason: 'Desistência via comando',
      });
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '🚪 Você saiu da fila',
              description: `Protocolo \`#${String(closed.protocol).padStart(4, '0')}\` encerrado.`,
              color: COLORS.MUTED,
            }),
          ],
        }),
      );
    } catch (error) {
      return respondError(interaction, error);
    }
  },
};
