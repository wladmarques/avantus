'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');
const { formatDuration } = require('../../utils/time');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('posicao')
    .setDescription('Mostra sua posição atual na fila de atendimento'),
  async execute({ interaction, services }) {
    const info = services.queue.positionOf(interaction.guildId, interaction.user.id);
    const cooldown = services.cooldowns.check(interaction.guildId, interaction.user.id);

    if (info.status === 'none' && cooldown.active) {
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '⏳ Aguarde para entrar novamente',
              description: [
                'Você saiu da fila antes de ser chamado.',
                '',
                `**Tempo restante:** ${services.cooldowns.message(cooldown).replace('⏳ ', '')}`,
              ].join('\n'),
              color: COLORS.WARNING,
            }),
          ],
        }),
      );
    }

    if (info.status === 'none') {
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '📊 Sua situação',
              description: 'Você não está na fila.\n\nUse o painel de atendimento ou o comando `/entrar` para entrar.',
              color: COLORS.MUTED,
            }),
          ],
        }),
      );
    }

    if (info.status === 'waiting') {
      const state = services.engine.getState(interaction.guildId);
      const estimate = services.engine.estimateWaitSeconds(state);
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '🎫 Sua posição na fila',
              description: [
                `**Protocolo:** \`#${String(info.entry.protocol).padStart(4, '0')}\``,
                `**Posição:** ${info.position}º`,
                `**Aguardando há:** ${formatDuration(info.entry.waitingSeconds)}`,
                `**Fila completa:** ${state.waiting.length} jogador(es)`,
                `**Previsão:** ${formatDuration(estimate)}`,
              ].join('\n'),
              color: COLORS.PURPLE,
            }),
          ],
        }),
      );
    }

    const label =
      info.status === 'serving' ? '🔴 Atendimento em andamento' : '⏸️ Atendimento pendente';
    return respond(
      interaction,
      ephemeral({
        embeds: [
          card({
            title: label,
            description: `Protocolo \`#${String(info.entry.protocol).padStart(4, '0')}\``,
            color: info.status === 'serving' ? COLORS.SUCCESS : COLORS.WARNING,
          }),
        ],
      }),
    );
  },
};
