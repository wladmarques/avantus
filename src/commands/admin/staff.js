'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS, STAFF_STATUS, STAFF_STATUS_META } = require('../../config/theme');
const { formatDateTime } = require('../../utils/time');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('staff')
    .setDescription('Gerencia a disponibilidade da equipe')
    .addSubcommand((sub) => sub.setName('lista').setDescription('Lista os staffs e seus status'))
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Altera o status de um membro da equipe')
        .addUserOption((option) =>
          option.setName('membro').setDescription('Membro da equipe').setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('situacao')
            .setDescription('Novo status')
            .setRequired(true)
            .addChoices(
              { name: 'Disponível', value: STAFF_STATUS.DISPONIVEL },
              { name: 'Em atendimento', value: STAFF_STATUS.EM_ATENDIMENTO },
              { name: 'Ausente', value: STAFF_STATUS.AUSENTE },
              { name: 'Indisponível', value: STAFF_STATUS.INDISPONIVEL },
            ),
        ),
    ),

  async execute({ interaction, services }) {
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'lista') {
        const list = services.staff.list(guildId);
        const counts = services.staff.counts(guildId);
        const description =
          list.length === 0
            ? '_Nenhum staff registrado ainda._'
            : list
                .map(
                  (entry) =>
                    `${entry.meta.emoji} <@${entry.userId}> — **${entry.meta.label}**${
                      entry.manual ? ' _(manual)_' : ''
                    }\n<:blank:0>`.replace('\n<:blank:0>', '\n'),
                )
                .join('\n');

        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '🛡️ Equipe de atendimento',
                description: [
                  description,
                  '',
                  `🟢 Disponíveis: **${counts.DISPONIVEL}** • 🔴 Em atendimento: **${counts.EM_ATENDIMENTO}** • 🟡 Ausentes: **${counts.AUSENTE}** • ⚫ Indisponíveis: **${counts.INDISPONIVEL}**`,
                ].join('\n'),
                color: COLORS.PURPLE,
              }),
            ],
          }),
        );
      }

      const member = interaction.options.getUser('membro');
      const status = interaction.options.getString('situacao');

      await services.staff.setStatus({
        guildId,
        userId: member.id,
        status,
        updatedBy: interaction.user.id,
        manual: true,
      });
      await services.audit.log({
        guildId,
        type: 'STAFF_STATUS_CHANGE',
        actorId: interaction.user.id,
        actorTag: interaction.member.displayName,
        targetId: member.id,
        message: `🛡️ <@${interaction.user.id}> alterou o status de <@${member.id}> para **${STAFF_STATUS_META[status].label}**.`,
        color: COLORS.INFO,
      });
      await services.panels.refresh(guildId).catch(() => null);

      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '✅ Status atualizado',
              description: `<@${member.id}> agora está como **${STAFF_STATUS_META[status].label}**.\n_Atualizado em ${formatDateTime()}._`,
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
