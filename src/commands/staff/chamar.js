'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('chamar')
    .setDescription('Chama o próximo jogador da fila (ou um jogador específico)')
    .addUserOption((option) =>
      option
        .setName('jogador')
        .setDescription('Chamar um jogador específico (fora da ordem)')
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('motivo')
        .setDescription('Motivo obrigatório ao chamar um jogador específico')
        .setMaxLength(300)
        .setRequired(false),
    ),
  async execute({ interaction, services }) {
    const guildId = interaction.guildId;
    const target = interaction.options.getUser('jogador');
    const reason = interaction.options.getString('motivo');

    try {
      let result;
      if (target) {
        const active = services.attendance.activeByUser(guildId, target.id);
        if (!active || active.status !== 'waiting') {
          return respond(interaction, ephemeral({ content: 'Este jogador não está aguardando na fila.' }));
        }
        result = await services.attendance.callSpecific({
          guildId,
          staffId: interaction.user.id,
          staffTag: interaction.member.displayName,
          attendanceId: active.id,
          reason,
        });
      } else {
        result = await services.attendance.callNext({
          guildId,
          staffId: interaction.user.id,
          staffTag: interaction.member.displayName,
        });
      }

      await services.panels.refresh(guildId).catch(() => null);
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '📞 Jogador chamado',
              description: [
                `**Jogador:** <@${result.attendance.user_id}>`,
                `**Protocolo:** \`#${String(result.attendance.protocol).padStart(4, '0')}\``,
                `**Canal:** 🔊 ${result.staffVoice.channelName ?? 'atendimento'}`,
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
