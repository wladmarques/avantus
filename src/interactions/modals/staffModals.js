'use strict';

const { defer, respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');
const { guardStaff, refreshPanels, displayName } = require('../helpers');

function parseModalId(customId) {
  const [namespace, kind, mode, attendanceId] = customId.split(':');
  if (namespace !== 'staff' || kind !== 'modal' || !mode || !attendanceId) return null;
  return { mode, attendanceId: Number(attendanceId) };
}

function protocolLabel(protocol) {
  return `#${String(protocol).padStart(4, '0')}`;
}

async function handleModal(interaction, { services }) {
  guardStaff(interaction, services);
  const parsed = parseModalId(interaction.customId);
  if (!parsed) return respond(interaction, ephemeral({ content: 'Formulário inválido.' }));

  const reason = interaction.fields.getTextInputValue('motivo')?.trim();
  const guildId = interaction.guildId;
  const actorId = interaction.user.id;
  const actorTag = displayName(interaction.member);

  await defer(interaction, { ephemeral: true });

  try {
    if (parsed.mode === 'call') {
      const result = await services.attendance.callSpecific({
        guildId,
        staffId: actorId,
        staffTag: actorTag,
        attendanceId: parsed.attendanceId,
        reason,
      });
      await refreshPanels(services, guildId);
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '📞 Jogador chamado (fora da ordem)',
              description: [
                `**Jogador:** <@${result.attendance.user_id}>`,
                `**Protocolo:** ${protocolLabel(result.attendance.protocol)}`,
                `**Motivo registrado:** ${reason}`,
                '',
                'A alteração da ordem foi registrada no histórico.',
              ].join('\n'),
              color: COLORS.SUCCESS,
            }),
          ],
        }),
      );
    }

    if (parsed.mode === 'skip') {
      const result = await services.queue.skip({
        guildId,
        attendanceId: parsed.attendanceId,
        actorId,
        actorTag,
        reason,
      });
      await refreshPanels(services, guildId);
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '⏭️ Jogador pulado',
              description: [
                `**Jogador:** <@${result.attendance.user_id}>`,
                `**Protocolo:** ${protocolLabel(result.attendance.protocol)}`,
                `**Ação:** ${result.mode === 'hold' ? 'mantido como pendente' : 'movido ao final da fila'}`,
                `**Motivo:** ${reason}`,
              ].join('\n'),
              color: COLORS.WARNING,
            }),
          ],
        }),
      );
    }

    if (parsed.mode === 'remove') {
      const closed = await services.queue.remove({
        guildId,
        attendanceId: parsed.attendanceId,
        actorId,
        actorTag,
        reason,
      });
      await refreshPanels(services, guildId);
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '🚫 Jogador removido',
              description: [
                `**Jogador:** <@${closed.user_id}>`,
                `**Protocolo:** ${protocolLabel(closed.protocol)}`,
                `**Resultado:** ${closed.outcome}`,
                `**Justificativa:** ${reason}`,
              ].join('\n'),
              color: COLORS.DANGER,
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

module.exports = { handleModal, parseModalId };
