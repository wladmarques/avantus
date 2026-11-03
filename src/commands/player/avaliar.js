'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS, RATING_META } = require('../../config/theme');

const CHOICES = Object.entries(RATING_META).map(([value, meta]) => ({
  name: `${meta.label} (${meta.score}/4)`,
  value,
}));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('avaliar')
    .setDescription('Avalia um atendimento que você já recebeu')
    // Ordem importa: o Discord exige as opções obrigatórias antes das opcionais.
    .addStringOption((option) =>
      option
        .setName('nota')
        .setDescription('Como foi o atendimento?')
        .setRequired(true)
        .addChoices(...CHOICES),
    )
    .addIntegerOption((option) =>
      option
        .setName('protocolo')
        .setDescription('Número do protocolo (vazio = último atendimento sem avaliação)')
        .setRequired(false)
        .setMinValue(1),
    ),

  async execute({ interaction, services }) {
    const protocol = interaction.options.getInteger('protocolo');
    const rating = interaction.options.getString('nota');

    try {
      const result = await services.evaluations.submitByProtocol({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        protocol: protocol ?? null,
        rating,
      });

      const meta = RATING_META[rating];
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '⭐ Obrigado pela avaliação!',
              description: [
                `Protocolo **#${String(result.protocol).padStart(4, '0')}** avaliado como **${meta.label}**.`,
                '',
                'A equipe VANTUS agradece o seu feedback.',
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
