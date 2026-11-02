'use strict';

const { defer, respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');
const { guardStaff, refreshPanels, displayName } = require('../helpers');
const { formatDuration } = require('../../utils/time');

const MODAL_FOR_MODE = {
  call: 'staff:modal:call',
  skip: 'staff:modal:skip',
  remove: 'staff:modal:remove',
};

function protocolLabel(protocol) {
  return `#${String(protocol).padStart(4, '0')}`;
}

async function handleSelect(interaction, { services, client }) {
  guardStaff(interaction, services);
  const customId = interaction.customId;
  const guildId = interaction.guildId;
  const attendanceId = interaction.values[0];

  // Menus que abrem formulário (motivo obrigatório)
  const mode = customId.split(':').at(-1);
  if (MODAL_FOR_MODE[mode]) {
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
    const titles = {
      call: 'Chamar jogador específico',
      skip: 'Pular jogador',
      remove: 'Remover jogador',
    };
    const modal = new ModalBuilder()
      .setCustomId(`${MODAL_FOR_MODE[mode]}:${attendanceId}`)
      .setTitle(titles[mode]);

    const input = new TextInputBuilder()
      .setCustomId('motivo')
      .setLabel(mode === 'call' ? 'Motivo da chamada fora da ordem' : 'Motivo (obrigatório)')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(300)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  await defer(interaction, { ephemeral: true });

  try {
    if (mode === 'status') {
      const status = interaction.values[0];
      await services.staff.setStatus({
        guildId,
        userId: interaction.user.id,
        status,
        updatedBy: interaction.user.id,
        manual: true,
      });
      await services.audit.log({
        guildId,
        type: 'STAFF_STATUS_CHANGE',
        actorId: interaction.user.id,
        actorTag: displayName(interaction.member),
        message: `🛡️ <@${interaction.user.id}> alterou o próprio status para **${status}**.`,
        color: COLORS.INFO,
      });
      await refreshPanels(services, guildId);
      return respond(
        interaction,
        ephemeral({ embeds: [card({ title: '✅ Status atualizado', description: `Agora você está como **${status}**.`, color: COLORS.SUCCESS })] }),
      );
    }

    if (mode === 'return') {
      const result = await services.queue.returnToQueue({
        guildId,
        attendanceId: Number(attendanceId),
        actorId: interaction.user.id,
        actorTag: displayName(interaction.member),
        reason: 'Devolução pelo painel',
      });
      await refreshPanels(services, guildId);
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '🔄 Jogador devolvido à fila',
              description: `**Jogador:** <@${result.attendance.user_id}>\n**Protocolo:** ${protocolLabel(result.attendance.protocol)}\n**Nova posição:** ${result.position}º`,
              color: COLORS.WARNING,
            }),
          ],
        }),
      );
    }

    if (mode === 'finish') {
      const closed = await services.attendance.finish({
        guildId,
        attendanceId: Number(attendanceId),
        actorId: interaction.user.id,
        actorTag: displayName(interaction.member),
        note: 'Finalizado pelo painel',
      });
      await refreshPanels(services, guildId);
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '✅ Atendimento finalizado',
              description: `**Jogador:** <@${closed.user_id}>\n**Protocolo:** ${protocolLabel(closed.protocol)}\n**Duração:** ${formatDuration(closed.duration_seconds)}`,
              color: COLORS.SUCCESS,
            }),
          ],
        }),
      );
    }

    if (mode === 'reactivate') {
      const row = await services.queue.reactivate({
        guildId,
        attendanceId: Number(attendanceId),
        actorId: interaction.user.id,
        actorTag: displayName(interaction.member),
      });
      await refreshPanels(services, guildId);
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '▶️ Jogador reativado',
              description: `**Jogador:** <@${row.user_id}>\n**Protocolo:** ${protocolLabel(row.protocol)}\nO jogador voltou para o final da fila.`,
              color: COLORS.SUCCESS,
            }),
          ],
        }),
      );
    }

    return respond(interaction, ephemeral({ content: 'Ação não reconhecida.' }));
  } catch (error) {
    return respondError(interaction, error);
  }
}

module.exports = { handleSelect };
