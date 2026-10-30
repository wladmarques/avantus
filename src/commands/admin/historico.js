'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS, OUTCOME_LABELS } = require('../../config/theme');
const { formatDateTime, formatDuration } = require('../../utils/time');

function recordLine(record) {
  return [
    `**#${String(record.protocol).padStart(4, '0')}** — <@${record.user_id}>`,
    `${OUTCOME_LABELS[record.outcome] ?? record.outcome ?? record.status}`,
    `Entrada ${formatDateTime(new Date(record.joined_at))}${
      record.staff_id ? ` • Staff <@${record.staff_id}>` : ''
    }`,
    record.wait_seconds !== null && record.wait_seconds !== undefined
      ? `Espera ${formatDuration(record.wait_seconds)} • Duração ${formatDuration(record.duration_seconds)}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('historico')
    .setDescription('Consulta o histórico de atendimentos')
    .addSubcommand((sub) =>
      sub
        .setName('protocolo')
        .setDescription('Detalhes completos de um protocolo')
        .addIntegerOption((option) =>
          option.setName('numero').setDescription('Número do protocolo').setMinValue(1).setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('jogador')
        .setDescription('Histórico de um jogador')
        .addUserOption((option) => option.setName('jogador').setDescription('Jogador').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('ultimos').setDescription('Últimos atendimentos encerrados')),

  async execute({ interaction, services }) {
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'protocolo') {
        const number = interaction.options.getInteger('numero');
        const record = services.repositories.attendance.findByProtocolSync(guildId, number);
        if (!record) return respond(interaction, ephemeral({ content: 'Protocolo não encontrado.' }));

        const events = services.audit.history(guildId, number).slice(-12);
        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: `🆔 Protocolo #${String(record.protocol).padStart(4, '0')}`,
                description: recordLine(record),
                color: COLORS.PURPLE,
                fields: [
                  { name: 'Jogador', value: `${record.username} (\`${record.user_id}\`)`, inline: true },
                  {
                    name: 'Staff',
                    value: record.staff_id ? `<@${record.staff_id}>\n${record.staff_tag ?? ''}` : '—',
                    inline: true,
                  },
                  { name: 'Status', value: record.status, inline: true },
                  {
                    name: 'Linha do tempo',
                    value:
                      events
                        .map((event) => `• ${formatDateTime(new Date(event.created_at))} — ${event.type}`)
                        .join('\n') || '_Sem registros._',
                  },
                  record.note ? { name: 'Observação', value: record.note } : null,
                ].filter(Boolean),
              }),
            ],
          }),
        );
      }

      if (sub === 'jogador') {
        const user = interaction.options.getUser('jogador');
        const records = services.attendance.history(guildId, user.id);
        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: `🗂️ Histórico de ${user.username}`,
                description:
                  records.length === 0
                    ? '_Nenhum atendimento registrado._'
                    : records.slice(0, 8).map(recordLine).join('\n\n'),
                color: COLORS.INFO,
              }),
            ],
          }),
        );
      }

      const records = services.attendance.recent(guildId, 10);
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '🗂️ Últimos atendimentos',
              description:
                records.length === 0
                  ? '_Nenhum atendimento registrado._'
                  : records.map(recordLine).join('\n\n'),
              color: COLORS.INFO,
            }),
          ],
        }),
      );
    } catch (error) {
      return respondError(interaction, error);
    }
  },
};
