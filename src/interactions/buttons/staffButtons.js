'use strict';

const { IDs, selectMenu } = require('../../dashboard/components/buttons');
const { defer, respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');
const { guardStaff, buildSelect, refreshPanels, displayName, STATUS_OPTIONS } = require('../helpers');
const { formatDuration } = require('../../utils/time');

function protocolLabel(protocol) {
  return `\`#${String(protocol).padStart(4, '0')}\``;
}

async function handleCallNext(interaction, { services }) {
  guardStaff(interaction, services);
  await defer(interaction, { ephemeral: true });

  try {
    const result = await services.attendance.callNext({
      guildId: interaction.guildId,
      staffId: interaction.user.id,
      staffTag: displayName(interaction.member),
    });

    await refreshPanels(services, interaction.guildId);
    return respond(
      interaction,
      ephemeral({
        embeds: [
          card({
            title: '📞 Jogador chamado',
            description: [
              `**Jogador:** <@${result.attendance.user_id}>`,
              `**Protocolo:** ${protocolLabel(result.attendance.protocol)}`,
              `**Canal:** 🔊 ${result.staffVoice.channelName ?? 'canal de atendimento'}`,
              `**Aguardando na fila:** ${result.remaining}`,
            ].join('\n'),
            color: COLORS.SUCCESS,
          }),
        ],
      }),
    );
  } catch (error) {
    return respondError(interaction, error);
  }
}

async function showSelect(interaction, { services }, mode) {
  guardStaff(interaction, services);
  const select = buildSelect(services, interaction.guildId, mode);
  if (select.empty) {
    return respond(interaction, ephemeral({ embeds: [card({ title: '🛡️ Painel da equipe', description: select.message, color: COLORS.WARNING })] }));
  }
  return respond(interaction, select.payload);
}

const STAFF_BUTTON_HANDLERS = {
  [IDs.STAFF_CALL_NEXT]: handleCallNext,
  [IDs.STAFF_CALL_SPECIFIC]: (interaction, ctx) => showSelect(interaction, ctx, 'call'),
  [IDs.STAFF_SKIP]: (interaction, ctx) => showSelect(interaction, ctx, 'skip'),
  [IDs.STAFF_RETURN]: (interaction, ctx) => showSelect(interaction, ctx, 'return'),
  [IDs.STAFF_FINISH]: async (interaction, { services }) => {
    guardStaff(interaction, services);
    const own = services.attendance.activeByStaff(interaction.guildId, interaction.user.id);
    if (own) {
      await defer(interaction, { ephemeral: true });
      try {
        const closed = await services.attendance.finish({
          guildId: interaction.guildId,
          attendanceId: own.id,
          actorId: interaction.user.id,
          actorTag: displayName(interaction.member),
          note: 'Finalizado pelo painel',
        });
        await refreshPanels(services, interaction.guildId);
        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '✅ Atendimento finalizado',
                description: [
                  `**Jogador:** <@${closed.user_id}>`,
                  `**Protocolo:** ${protocolLabel(closed.protocol)}`,
                  `**Duração:** ${formatDuration(closed.duration_seconds)}`,
                  '',
                  'O jogador recebeu a avaliação no privado.',
                ].join('\n'),
                color: COLORS.SUCCESS,
              }),
            ],
          }),
        );
      } catch (error) {
        return respondError(interaction, error);
      }
    }
    return showSelect(interaction, { services }, 'finish');
  },
  [IDs.STAFF_REMOVE]: (interaction, ctx) => showSelect(interaction, ctx, 'remove'),
  [IDs.STAFF_REACTIVATE]: (interaction, ctx) => showSelect(interaction, ctx, 'reactivate'),
  [IDs.STAFF_REFRESH]: async (interaction, { services }) => {
    guardStaff(interaction, services);
    await defer(interaction, { ephemeral: true });
    await services.panels.refresh(interaction.guildId).catch(() => null);
    return respond(
      interaction,
      ephemeral({ embeds: [card({ title: '🔄 Painel atualizado', description: 'As informações foram recarregadas.', color: COLORS.INFO })] }),
    );
  },
  [IDs.STAFF_MY_STATUS]: async (interaction, { services }) => {
    guardStaff(interaction, services);
    const current = services.staff.get(interaction.guildId, interaction.user.id);
    return respond(
      interaction,
      ephemeral({
        embeds: [
          card({
            title: '🟢 Seu status de atendimento',
            description: `Status atual: **${current.status === 'EM_ATENDIMENTO' ? 'EM ATENDIMENTO' : current.status}**\n\nEscolha abaixo como deseja ficar disponível.`,
            color: COLORS.PURPLE,
          }),
        ],
        components: [
          selectMenu(
            'staff:select:status',
            'Alterar meu status',
            STATUS_OPTIONS.map((option) => ({
              ...option,
              default: option.value === current.status,
            })),
          ),
        ],
      }),
    );
  },
};

module.exports = { STAFF_BUTTON_HANDLERS, handleCallNext };
