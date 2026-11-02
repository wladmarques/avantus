'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('devolver')
    .setDescription('Devolve o jogador do seu atendimento ao final da fila')
    .addStringOption((option) =>
      option
        .setName('motivo')
        .setDescription('Por que o atendimento não pôde ser realizado agora?')
        .setMaxLength(300)
        .setRequired(false),
    ),
  async execute({ interaction, services }) {
    const guildId = interaction.guildId;
    const active = services.attendance.activeByStaff(guildId, interaction.user.id);
    if (!active) {
      return respond(interaction, ephemeral({ content: 'Você não possui atendimento em andamento.' }));
    }

    try {
      const result = await services.queue.returnToQueue({
        guildId,
        attendanceId: active.id,
        actorId: interaction.user.id,
        actorTag: interaction.member.displayName,
        reason: interaction.options.getString('motivo'),
      });
      await services.panels.refresh(guildId).catch(() => null);
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '🔄 Jogador devolvido à fila',
              description: [
                `**Jogador:** <@${result.attendance.user_id}>`,
                `**Protocolo:** \`#${String(result.attendance.protocol).padStart(4, '0')}\``,
                `**Nova posição:** ${result.position}º`,
              ].join('\n'),
              color: COLORS.WARNING,
            }),
          ],
        }),
      );
    } catch (error) {
      return respondError(interaction, error);
    }
  },
};
