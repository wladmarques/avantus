'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');
const { describeSchedule } = require('../../utils/time');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('central')
    .setDescription('Controla a abertura e o fechamento da central de atendimento')
    .addSubcommand((sub) => sub.setName('abrir').setDescription('Abre a central manualmente'))
    .addSubcommand((sub) =>
      sub
        .setName('fechar')
        .setDescription('Fecha a central manualmente')
        .addBooleanOption((option) =>
          option
            .setName('limpar_fila')
            .setDescription('Encerrar também a fila existente (senão a fila é mantida)')
            .setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('motivo').setDescription('Motivo do fechamento').setMaxLength(300).setRequired(false),
        ),
    )
    .addSubcommand((sub) => sub.setName('alternar').setDescription('Alterna entre aberta e fechada'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Mostra o status atual da central')),

  async execute({ interaction, services }) {
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'status') {
        const status = services.central.status(guildId);
        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '📊 Status da central',
                description: [
                  `**Situação:** ${status.open ? '🟢 ABERTA' : '📕 FECHADA'}`,
                  `**Modo:** ${status.manual === 'auto' ? 'Automático (horário)' : 'Manual'}`,
                  `**Hoje:** ${status.today.text}`,
                  '',
                  '**Horários configurados**',
                  describeSchedule(services.settings.get('schedule')),
                ].join('\n'),
                color: status.open ? COLORS.SUCCESS : COLORS.MUTED,
              }),
            ],
          }),
        );
      }

      const actor = {
        guildId,
        actorId: interaction.user.id,
        actorTag: interaction.member.displayName,
      };

      let status;
      if (sub === 'abrir') status = await services.central.open(actor);
      else if (sub === 'fechar')
        status = await services.central.close({
          ...actor,
          clearQueue: interaction.options.getBoolean('limpar_fila') ?? false,
          reason: interaction.options.getString('motivo'),
        });
      else status = await services.central.toggle(actor);

      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: status.open ? '🟢 Central aberta' : '📕 Central fechada',
              description: [
                `A central agora está **${status.open ? 'ABERTA' : 'FECHADA'}**.`,
                `**Hoje:** ${status.today.text}`,
                '',
                'Use `/central status` para conferir os detalhes.',
              ].join('\n'),
              color: status.open ? COLORS.SUCCESS : COLORS.MUTED,
            }),
          ],
        }),
      );
    } catch (error) {
      return respondError(interaction, error);
    }
  },
};
