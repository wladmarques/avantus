'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');
const { formatDuration } = require('../../utils/time');
const { WEEKDAY_LABELS, normalizeShift } = require('../../systems/hourbank/shiftSchedule');
const { assertAdmin } = require('../../config/permissions');

const DAY_CHOICES = WEEKDAY_LABELS.map((label, value) => ({ name: label, value: String(value) }));

function scheduleText(shifts) {
  if (!shifts.length) return '_Nenhum turno cadastrado. Peça à administração ou use o painel web._';
  return shifts
    .slice()
    .sort((a, b) => a.weekday - b.weekday || a.startMinutes - b.startMinutes)
    .map((shift) => `**${shift.weekdayLabel}:** ${shift.start} às ${shift.end}`)
    .join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('banco')
    .setDescription('Banco de horas da equipe')
    .addSubcommand((sub) =>
      sub.setName('ver').setDescription('Mostra as suas horas, escala e atrasos'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('staff')
        .setDescription('Mostra o banco de horas de um membro da equipe')
        .addUserOption((option) =>
          option.setName('membro').setDescription('Membro da equipe').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('equipe')
        .setDescription('Resumo de horas de toda a equipe (últimos 7 dias)'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('escala')
        .setDescription('Cadastra um turno na escala de um staff')
        .addUserOption((option) =>
          option.setName('membro').setDescription('Membro da equipe').setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('dia')
            .setDescription('Dia da semana')
            .setRequired(true)
            .addChoices(...DAY_CHOICES),
        )
        .addStringOption((option) =>
          option.setName('inicio').setDescription('Início (HH:MM)').setRequired(true).setMaxLength(5),
        )
        .addStringOption((option) =>
          option.setName('fim').setDescription('Fim (HH:MM)').setRequired(true).setMaxLength(5),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('limpar')
        .setDescription('Remove toda a escala de um staff')
        .addUserOption((option) =>
          option.setName('membro').setDescription('Membro da equipe').setRequired(true),
        ),
    ),

  async execute({ interaction, services, member }) {
    const guildId = interaction.guildId;
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === 'ver' || subcommand === 'staff') {
        const target =
          subcommand === 'ver'
            ? interaction.user.id
            : interaction.options.getUser('membro')?.id ?? interaction.user.id;

        const summary = services.hourBank.summary(guildId, target);
        const active = summary.active;
        const next = summary.nextShift;

        const description = [
          active
            ? `**Em serviço desde:** ${new Date(active.started_at).toISOString().slice(11, 16)} • ${formatDuration(
                active.elapsedSeconds,
              )} nesta sessão`
            : '**Agora:** fora de serviço',
          '',
          `**Hoje:** ${formatDuration(summary.todayMinutes * 60)}`,
          `**Últimos 7 dias:** ${formatDuration(summary.weekMinutes * 60)} (${summary.weekSessions} sessão(ões))`,
          `**Atrasos:** ${summary.lateCount} • ${formatDuration(summary.lateMinutes * 60)} de atraso acumulado`,
          '',
          '**Escala:**',
          scheduleText(summary.shifts),
        ].join('\n');

        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: `⏱️ Banco de horas • ${target === interaction.user.id ? 'você' : `<@${target}>`}`,
                description,
                color: COLORS.ACCENT,
                fields: next
                  ? [
                      {
                        name: 'Próximo turno',
                        value: `${next.weekdayLabel} • ${next.start} às ${next.end} (em ${formatDuration(
                          Math.max(0, next.minutesAhead) * 60,
                        )})`,
                        inline: false,
                      },
                    ]
                  : [],
                footer: 'Acompanhe detalhes e edite a escala no painel web do banco de horas.',
              }),
            ],
          }),
        );
      }

      // A partir daqui: administração
      assertAdmin(member, services.settings);

      if (subcommand === 'equipe') {
        const report = services.hourBank.report(guildId);
        const lines = report.staff.length
          ? report.staff
              .map(
                (item) =>
                  `**${item.staffName ?? `<@${item.userId}>`}** — ${item.totalLabel} • ${
                    item.sessions
                  } sessão(ões)${item.lateCount ? ` • ${item.lateCount} atraso(s)` : ''}`,
              )
              .join('\n')
          : '_Nenhuma sessão registrada no período._';

        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '⏱️ Banco de horas da equipe',
                description: [
                  `**Período:** ${report.period.from} a ${report.period.to}`,
                  `**Total:** ${formatDuration(report.totals.minutes * 60)} • ${report.totals.sessions} sessão(ões)`,
                  '',
                  lines,
                ].join('\n'),
                color: COLORS.ACCENT,
                footer: 'Relatório completo e edição de escalas no painel web.',
              }),
            ],
          }),
        );
      }

      if (subcommand === 'escala') {
        const target = interaction.options.getUser('membro');
        const weekday = Number(interaction.options.getString('dia'));
        const start = interaction.options.getString('inicio');
        const end = interaction.options.getString('fim');
        const shift = normalizeShift({ weekday, start, end });

        const existing = services.hourBank.listShifts(guildId, target.id);
        const shifts = existing
          .filter((item) => !(item.weekday === shift.weekday && item.startMinutes === shift.startMinutes && item.endMinutes === shift.endMinutes))
          .map((item) => ({ weekday: item.weekday, start: item.start, end: item.end }));
        shifts.push({ weekday, start, end });

        const saved = await services.hourBank.setSchedule({
          guildId,
          userId: target.id,
          staffName: target.username,
          shifts,
        });

        await services.audit.log({
          guildId,
          type: 'HOUR_BANK_SCHEDULE',
          actorId: interaction.user.id,
          actorTag: interaction.member?.displayName,
          targetId: target.id,
          message: `⏱️ <@${interaction.user.id}> cadastrou o turno de **${target.username}**: ${WEEKDAY_LABELS[weekday]} ${start} às ${end}.`,
          color: COLORS.INFO,
        });

        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '⏱️ Escala atualizada',
                description: `**${target.username}**\n\n${scheduleText(saved)}`,
                color: COLORS.SUCCESS,
              }),
            ],
          }),
        );
      }

      if (subcommand === 'limpar') {
        const target = interaction.options.getUser('membro');
        await services.hourBank.clearSchedule({ guildId, userId: target.id });
        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '⏱️ Escala removida',
                description: `A escala de **${target.username}** foi apagada.`,
                color: COLORS.MUTED,
              }),
            ],
          }),
        );
      }

      return null;
    } catch (error) {
      return respondError(interaction, error);
    }
  },
};
