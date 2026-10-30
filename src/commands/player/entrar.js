'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('entrar')
    .setDescription('Entra na fila de atendimento da VANTUS'),
  async execute({ interaction, services }) {
    await interaction.deferReply({ flags: 64 });
    try {
      const result = await services.queue.join({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        displayName: interaction.member?.displayName || interaction.user.username,
        source: 'comando /entrar',
      });
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '🎫 Você está na fila!',
              description: [
                `**Protocolo:** \`#${String(result.protocol).padStart(4, '0')}\``,
                `**Posição:** ${result.position}º`,
                '',
                'Aguarde no canal de voz de espera. Você será avisado no privado quando for chamado.',
              ].join('\n'),
              color: COLORS.ORANGE,
            }),
          ],
        }),
      );
    } catch (error) {
      return respondError(interaction, error);
    }
  },
};
