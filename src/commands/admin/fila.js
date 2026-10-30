'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');
const { formatTime, formatDuration } = require('../../utils/time');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('fila')
    .setDescription('Administra a fila de atendimento')
    .addSubcommand((sub) => sub.setName('ver').setDescription('Mostra a fila completa'))
    .addSubcommand((sub) =>
      sub
        .setName('pular')
        .setDescription('Pula um jogador (obrigatório informar o motivo)')
        .addUserOption((option) => option.setName('jogador').setDescription('Jogador').setRequired(true))
        .addStringOption((option) =>
          option.setName('motivo').setDescription('Motivo do pulo').setMaxLength(300).setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remover')
        .setDescription('Remove um jogador da fila/atendimento (justificativa obrigatória)')
        .addUserOption((option) => option.setName('jogador').setDescription('Jogador').setRequired(true))
        .addStringOption((option) =>
          option.setName('motivo').setDescription('Justificativa').setMaxLength(300).setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reativar')
        .setDescription('Devolve um jogador pendente para a fila')
        .addUserOption((option) => option.setName('jogador').setDescription('Jogador').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('liberar')
        .setDescription('Remove o bloqueio de reentrada de um jogador')
        .addUserOption((option) => option.setName('jogador').setDescription('Jogador').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('limpar')
        .setDescription('Encerra a fila inteira')
        .addStringOption((option) =>
          option.setName('motivo').setDescription('Motivo').setMaxLength(300).setRequired(false),
        ),
    ),

  async execute({ interaction, services }) {
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'ver') {
        const state = services.engine.getState(guildId);
        const waiting =
          state.waiting.length === 0
            ? '_Fila vazia._'
            : state.waiting
                .map(
                  (entry) =>
                    `**#${String(entry.position).padStart(2, '0')} — ${entry.username}**\n` +
                    `\`#${String(entry.protocol).padStart(4, '0')}\` • entrada ${formatTime(
                      new Date(entry.joined_at),
                    )} • espera ${formatDuration(entry.waitingSeconds)}`,
                )
                .join('\n\n');

        const blocked = services.cooldowns.repo.listActiveSync(guildId);
        const blockedBlock =
          blocked.length === 0
            ? null
            : blocked
                .map(
                  (row) =>
                    `⏳ <@${row.user_id}> — libera em ${formatDuration(
                      Math.ceil((row.until - Date.now()) / 1000),
                    )}`,
                )
                .join('\n');

        const serving =
          state.serving.length === 0
            ? '_Nenhum._'
            : state.serving
                .map(
                  (entry) =>
                    `🔴 ${entry.username} — \`#${String(entry.protocol).padStart(4, '0')}\` • <@${entry.staff_id}> • ${formatDuration(
                      entry.servingSeconds,
                    )}`,
                )
                .join('\n');

        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '📋 Fila de atendimento',
                description: [
                  `**Aguardando**\n${waiting}`,
                  '',
                  `**Em atendimento**\n${serving}`,
                  blockedBlock ? `\n**Bloqueados para reentrada**\n${blockedBlock}` : null,
                ]
                  .filter((line) => line !== null)
                  .join('\n'),
                color: COLORS.PURPLE,
                fields: [
                  { name: 'Na fila', value: `${state.waiting.length}`, inline: true },
                  { name: 'Em atendimento', value: `${state.serving.length}`, inline: true },
                  { name: 'Pendentes', value: `${state.hold.length}`, inline: true },
                ],
              }),
            ],
          }),
        );
      }

      if (sub === 'liberar') {
        const target = interaction.options.getUser('jogador');
        const previous = services.cooldowns.check(guildId, target.id);
        await services.cooldowns.clear(guildId, target.id);
        await services.audit.log({
          guildId,
          type: 'COOLDOWN_CLEARED',
          actorId: interaction.user.id,
          actorTag: interaction.member.displayName,
          targetId: target.id,
          message: `🔓 <@${interaction.user.id}> liberou <@${target.id}> do bloqueio de reentrada${
            previous.active ? ` (faltavam ${previous.remainingSeconds}s)` : ''
          }.`,
          color: COLORS.INFO,
        });
        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '🔓 Bloqueio removido',
                description: previous.active
                  ? `<@${target.id}> já pode entrar na fila novamente.`
                  : `<@${target.id}> não estava bloqueado.`,
                color: COLORS.SUCCESS,
              }),
            ],
          }),
        );
      }

      if (sub === 'limpar') {
        const count = await services.queue.clear({
          guildId,
          actorId: interaction.user.id,
          actorTag: interaction.member.displayName,
          reason: interaction.options.getString('motivo') || 'Fila encerrada pela administração',
        });
        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '🧹 Fila encerrada',
                description: `${count} registro(s) encerrado(s) e notificado(s).`,
                color: COLORS.WARNING,
              }),
            ],
          }),
        );
      }

      const target = interaction.options.getUser('jogador');
      const active = services.attendance.activeByUser(guildId, target.id);
      if (!active) {
        return respond(interaction, ephemeral({ content: 'Este jogador não possui registro ativo.' }));
      }

      if (sub === 'pular') {
        const result = await services.queue.skip({
          guildId,
          attendanceId: active.id,
          actorId: interaction.user.id,
          actorTag: interaction.member.displayName,
          reason: interaction.options.getString('motivo'),
        });
        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '⏭️ Jogador pulado',
                description: `<@${target.id}> — \`#${String(result.attendance.protocol).padStart(4, '0')}\`\nAção: ${
                  result.mode === 'hold' ? 'pendente' : 'movido ao final da fila'
                }`,
                color: COLORS.WARNING,
              }),
            ],
          }),
        );
      }

      if (sub === 'reativar') {
        const row = await services.queue.reactivate({
          guildId,
          attendanceId: active.id,
          actorId: interaction.user.id,
          actorTag: interaction.member.displayName,
        });
        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '▶️ Jogador reativado',
                description: `<@${target.id}> voltou para a fila (\`#${String(row.protocol).padStart(4, '0')}\`).`,
                color: COLORS.SUCCESS,
              }),
            ],
          }),
        );
      }

      const closed = await services.queue.remove({
        guildId,
        attendanceId: active.id,
        actorId: interaction.user.id,
        actorTag: interaction.member.displayName,
        reason: interaction.options.getString('motivo'),
      });
      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '🚫 Jogador removido',
              description: `<@${target.id}> — \`#${String(closed.protocol).padStart(4, '0')}\`\nResultado: **${closed.outcome}**`,
              color: COLORS.DANGER,
            }),
          ],
        }),
      );
    } catch (error) {
      return respondError(interaction, error);
    }
  },
};
