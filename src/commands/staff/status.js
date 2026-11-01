'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS, STAFF_STATUS_META } = require('../../config/theme');

const CHOICES = [
  ['Disponível', 'DISPONIVEL'],
  ['Ausente', 'AUSENTE'],
  ['Indisponível', 'INDISPONIVEL'],
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Define a sua disponibilidade na equipe')
    .addStringOption((option) =>
      option
        .setName('situacao')
        .setDescription('Novo status')
        .setRequired(true)
        .addChoices(...CHOICES.map(([name, value]) => ({ name, value }))),
    ),
  async execute({ interaction, services }) {
    const status = interaction.options.getString('situacao');
    try {
      await services.staff.setStatus({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        status,
        updatedBy: interaction.user.id,
        manual: true,
      });
      await services.audit.log({
        guildId: interaction.guildId,
        type: 'STAFF_STATUS_CHANGE',
        actorId: interaction.user.id,
        actorTag: interaction.member.displayName,
        message: `🛡️ <@${interaction.user.id}> definiu o próprio status como **${STAFF_STATUS_META[status].label}**.`,
        color: COLORS.INFO,
      });
      await services.panels.refresh(interaction.guildId).catch(() => null);
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: `${STAFF_STATUS_META[status].emoji} Status atualizado`,
              description: `Agora você está como **${STAFF_STATUS_META[status].label}**.`,
              color: STAFF_STATUS_META[status].color,
            }),
          ],
        }),
      );
    } catch (error) {
      return respondError(interaction, error);
    }
  },
};
