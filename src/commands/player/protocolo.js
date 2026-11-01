'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS, OUTCOME_LABELS } = require('../../config/theme');
const { formatDateTime, formatDuration } = require('../../utils/time');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('protocolo')
    .setDescription('Consulta o histórico do seu protocolo de atendimento')
    .addIntegerOption((option) =>
      option
        .setName('numero')
        .setDescription('Número do protocolo (ex.: 1 para #0001). Sem número, mostra os últimos.')
        .setMinValue(1)
        .setRequired(false),
    ),
  async execute({ interaction, services }) {
    const guildId = interaction.guildId;
    const number = interaction.options.getInteger('numero');
    const record = number
      ? services.repositories.attendance.findByProtocolSync(guildId, number)
      : services.repositories.attendance
          .listByUserSync(guildId, interaction.user.id, { limit: 1 })
          .at(0);

    if (!record || (record.user_id !== interaction.user.id && !number)) {
      return respond(
        interaction,
        ephemeral({ content: 'Nenhum atendimento encontrado para você.' }),
      );
    }

    const fields = [
      { name: 'Jogador', value: `<@${record.user_id}>`, inline: true },
      { name: 'Protocolo', value: `#${String(record.protocol).padStart(4, '0')}`, inline: true },
      { name: 'Status', value: record.status, inline: true },
      { name: 'Entrada', value: formatDateTime(new Date(record.joined_at)), inline: true },
      record.started_at
        ? { name: 'Início', value: formatDateTime(new Date(record.started_at)), inline: true }
        : null,
      record.ended_at
        ? { name: 'Encerrado', value: formatDateTime(new Date(record.ended_at)), inline: true }
        : null,
      record.wait_seconds ? { name: 'Espera', value: formatDuration(record.wait_seconds), inline: true } : null,
      record.duration_seconds
        ? { name: 'Duração', value: formatDuration(record.duration_seconds), inline: true }
        : null,
      record.outcome
        ? { name: 'Resultado', value: OUTCOME_LABELS[record.outcome] ?? record.outcome, inline: false }
        : null,
      record.staff_id ? { name: 'Atendente', value: `<@${record.staff_id}>`, inline: true } : null,
    ].filter(Boolean);

    return respond(
      interaction,
      ephemeral({
        embeds: [
          card({
            title: `🆔 Protocolo #${String(record.protocol).padStart(4, '0')}`,
            description: 'Resumo do seu atendimento na central VANTUS.',
            fields,
            color: COLORS.PURPLE,
          }),
        ],
      }),
    );
  },
};
