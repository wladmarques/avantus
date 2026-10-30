'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');
const { describeSchedule, DAY_LABELS } = require('../../utils/time');
const { DEFAULT_SCHEDULE } = require('../../config/settings');
const { isValidHHMM } = require('../../utils/validators');

const DAY_CHOICES = Object.entries(DAY_LABELS).map(([value, name]) => ({ name, value }));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('horario')
    .setDescription('Configura o horário de funcionamento da central')
    .addSubcommand((sub) => sub.setName('ver').setDescription('Mostra a agenda atual'))
    .addSubcommand((sub) =>
      sub
        .setName('definir')
        .setDescription('Define uma janela de atendimento para um dia')
        .addStringOption((option) =>
          option.setName('dia').setDescription('Dia da semana').setRequired(true).addChoices(...DAY_CHOICES),
        )
        .addStringOption((option) =>
          option.setName('abertura').setDescription('Horário de abertura (HH:MM)').setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('fechamento')
            .setDescription('Horário de fechamento (HH:MM). Pode virar a madrugada, ex.: 02:00')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('fechar_dia')
        .setDescription('Remove o atendimento de um dia da semana')
        .addStringOption((option) =>
          option.setName('dia').setDescription('Dia da semana').setRequired(true).addChoices(...DAY_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('modelo').setDescription('Aplica o modelo padrão VANTUS (12:00–02:00 e 12:00–00:00)'),
    ),

  async execute({ interaction, services }) {
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();
    const schedule = { ...(services.settings.get('schedule') || {}) };

    try {
      if (sub === 'ver') {
        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '🗓️ Horário de funcionamento',
                description: describeSchedule(schedule),
                color: COLORS.PURPLE,
                footer: 'Fuso horário: America/Sao_Paulo',
              }),
            ],
          }),
        );
      }

      if (sub === 'modelo') {
        await services.settings.set('schedule', DEFAULT_SCHEDULE);
        await services.audit.log({
          guildId,
          type: 'SCHEDULE_UPDATE',
          actorId: interaction.user.id,
          actorTag: interaction.member.displayName,
          message: `🗓️ <@${interaction.user.id}> aplicou o modelo padrão de horários.`,
          color: COLORS.INFO,
        });
        await services.panels.refresh(guildId).catch(() => null);
        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '✅ Modelo aplicado',
                description: describeSchedule(DEFAULT_SCHEDULE),
                color: COLORS.SUCCESS,
              }),
            ],
          }),
        );
      }

      const day = interaction.options.getString('dia');

      if (sub === 'fechar_dia') {
        schedule[day] = [];
        await services.settings.set('schedule', schedule);
        await services.panels.refresh(guildId).catch(() => null);
        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '✅ Dia desativado',
                description: `${DAY_LABELS[day]} não terá atendimento.`,
                color: COLORS.SUCCESS,
              }),
            ],
          }),
        );
      }

      const open = interaction.options.getString('abertura');
      const close = interaction.options.getString('fechamento');
      if (!isValidHHMM(open) || !isValidHHMM(close)) {
        return respond(interaction, ephemeral({ content: 'Use o formato HH:MM (ex.: 12:00).' }));
      }
      if (open === close) {
        return respond(interaction, ephemeral({ content: 'Abertura e fechamento não podem ser iguais.' }));
      }

      schedule[day] = [{ open, close }];
      await services.settings.set('schedule', schedule);
      await services.audit.log({
        guildId,
        type: 'SCHEDULE_UPDATE',
        actorId: interaction.user.id,
        actorTag: interaction.member.displayName,
        message: `🗓️ <@${interaction.user.id}> definiu ${DAY_LABELS[day]}: **${open} às ${close}**.`,
        color: COLORS.INFO,
      });
      await services.panels.refresh(guildId).catch(() => null);

      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '✅ Horário atualizado',
              description: `**${DAY_LABELS[day]}:** ${open} às ${close}\n\n${describeSchedule(schedule)}`,
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
