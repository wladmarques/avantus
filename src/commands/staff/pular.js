'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pular')
    .setDescription('Pula temporariamente um jogador da fila (motivo obrigatório)')
    .addUserOption((option) =>
      option.setName('jogador').setDescription('Jogador que será pulado').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('motivo').setDescription('Motivo do pulo').setMaxLength(300).setRequired(true),
    ),
  async execute({ interaction, services }) {
    const guildId = interaction.guildId;
    const target = interaction.options.getUser('jogador');
    const reason = interaction.options.getString('motivo');

    const active = services.attendance.activeByUser(guildId, target.id);
    if (!active || active.status !== 'waiting') {
      return respond(interaction, ephemeral({ content: 'Este jogador não está aguardando na fila.' }));
    }

    try {
      const result = await services.queue.skip({
        guildId,
        attendanceId: active.id,
        actorId: interaction.user.id,
        actorTag: interaction.member.displayName,
        reason,
      });
      await services.panels.refresh(guildId).catch(() => null);
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '⏭️ Jogador pulado',
              description: [
                `**Jogador:** <@${result.attendance.user_id}>`,
                `**Protocolo:** \`#${String(result.attendance.protocol).padStart(4, '0')}\``,
                `**Ação:** ${result.mode === 'hold' ? 'marcado como pendente' : 'movido ao final da fila'}`,
                `**Motivo:** ${reason}`,
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
