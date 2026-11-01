'use strict';

const { IDs } = require('../../dashboard/components/buttons');
const { defer, respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS, STAFF_STATUS_META } = require('../../config/theme');
const { formatDuration, describeSchedule } = require('../../utils/time');

async function handleJoin(interaction, { services }) {
  await defer(interaction, { ephemeral: true });
  const guildId = interaction.guildId;

  try {
    const result = await services.queue.join({
      guildId,
      userId: interaction.user.id,
      displayName: interaction.member?.displayName || interaction.user.username,
      source: 'painel público',
      // Só entra na fila quem está na call de espera.
      requireWaitChannel: true,
    });

    return respond(
      interaction,
      ephemeral({
        embeds: [
          card({
            title: '🎫 Você está na fila!',
            description: [
              'Sua entrada foi registrada com sucesso.',
              '',
              `**Protocolo:** \`#${String(result.protocol).padStart(4, '0')}\``,
              `**Posição na fila:** ${result.position}º`,
              '',
              'Continue no canal de voz de espera. Você receberá uma mensagem privada quando for chamado.',
            ].join('\n'),
            color: COLORS.ORANGE,
          }),
        ],
      }),
    );
  } catch (error) {
    return respondError(interaction, error);
  }
}

async function handleLeave(interaction, { services }) {
  await defer(interaction, { ephemeral: true });
  const guildId = interaction.guildId;

  try {
    const closed = await services.queue.leave({
      guildId,
      userId: interaction.user.id,
      actorId: interaction.user.id,
      reason: 'Desistência pelo painel',
    });

    return respond(
      interaction,
      ephemeral({
        embeds: [
          card({
            title: '🚪 Você saiu da fila',
            description: `Protocolo \`#${String(closed.protocol).padStart(4, '0')}\` encerrado.\n\nVocê pode entrar novamente quando precisar.`,
            color: COLORS.MUTED,
          }),
        ],
      }),
    );
  } catch (error) {
    return respondError(interaction, error);
  }
}

async function handleStatus(interaction, { services }) {
  await defer(interaction, { ephemeral: true });
  const guildId = interaction.guildId;
  const info = services.queue.positionOf(guildId, interaction.user.id);
  const status = services.central.status(guildId);

  if (info.status === 'none') {
    return respond(
      interaction,
      ephemeral({
        embeds: [
          card({
            title: '📊 Sua situação',
            description: [
              'Você **não está** na fila de atendimento.',
              '',
              `**Central:** ${status.open ? '🟢 ABERTA' : '📕 FECHADA'}`,
              `**Hoje:** ${status.today.text}`,
            ].join('\n'),
            color: COLORS.MUTED,
            fields: [{ name: 'Horários', value: describeSchedule(services.settings.get('schedule')) }],
          }),
        ],
      }),
    );
  }

  if (info.status === 'waiting') {
    const state = services.engine.getState(guildId);
    return respond(
      interaction,
      ephemeral({
        embeds: [
          card({
            title: '📊 Sua posição na fila',
            description: [
              `**Protocolo:** \`#${String(info.entry.protocol).padStart(4, '0')}\``,
              `**Posição:** ${info.position}º`,
              `**Aguardando há:** ${formatDuration(info.entry.waitingSeconds)}`,
              `**Previsão de espera:** ${formatDuration(services.engine.estimateWaitSeconds(state))}`,
            ].join('\n'),
            color: COLORS.PURPLE,
          }),
        ],
      }),
    );
  }

  if (info.status === 'hold') {
    return respond(
      interaction,
      ephemeral({
        embeds: [
          card({
            title: '⏸️ Seu atendimento está pendente',
            description: `Protocolo \`#${String(info.entry.protocol).padStart(4, '0')}\` está pendente na fila.\n\nA equipe irá reativá-lo em breve.`,
            color: COLORS.WARNING,
          }),
        ],
      }),
    );
  }

  return respond(
    interaction,
    ephemeral({
      embeds: [
        card({
          title: '🔴 Atendimento em andamento',
          description: `Protocolo \`#${String(info.entry.protocol).padStart(4, '0')}\` com **${STAFF_STATUS_META.EM_ATENDIMENTO.label}**.\n\nDirija-se ao canal de voz indicado.`,
          color: COLORS.SUCCESS,
        }),
      ],
    }),
  );
}

const PUBLIC_BUTTON_HANDLERS = {
  [IDs.PUBLIC_JOIN]: handleJoin,
  [IDs.PUBLIC_LEAVE]: handleLeave,
  [IDs.PUBLIC_STATUS]: handleStatus,
};

module.exports = { PUBLIC_BUTTON_HANDLERS, handleJoin, handleLeave, handleStatus };
