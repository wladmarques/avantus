'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');

const VOICE_ATTENDANCE = ['ATENDIMENTO 01', 'ATENDIMENTO 02', 'ATENDIMENTO 03'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Cria a estrutura de canais e publica os painéis automaticamente')
    .addBooleanOption((option) =>
      option
        .setName('criar_cargos')
        .setDescription('Criar os cargos "Staff VANTUS" e "Admin VANTUS" se não existirem')
        .setRequired(false),
    ),
  async execute({ interaction, services, client }) {
    const guildId = interaction.guildId;
    const discord = client ?? interaction.client;
    await deferSafe(interaction);

    try {
      const guild = discord?.guilds?.cache?.get(guildId);
      if (!guild) throw new Error('Servidor não encontrado.');

      const gateway = services.gateway;
      const created = [];

      const category = await gateway.ensureCategory(guildId, 'CENTRAL DE ATENDIMENTO');
      created.push(`📁 Categoria: **${category.name}**`);

      const waitChannel = await gateway.ensureVoiceChannel(guildId, 'AGUARDANDO ATENDIMENTO', category.id);
      created.push(`🔊 Voz: **${waitChannel.name}**`);

      const attendanceChannels = [];
      for (const name of VOICE_ATTENDANCE) {
        const channel = await gateway.ensureVoiceChannel(guildId, name, category.id);
        attendanceChannels.push(channel.id);
        created.push(`🔊 Voz: **${channel.name}**`);
      }

      const publicChannel = await gateway.ensureTextChannel(guildId, 'central-atendimento', null);
      const staffChannel = await gateway.ensureTextChannel(guildId, 'painel-staff', null);
      const logChannel = await gateway.ensureTextChannel(guildId, 'logs-atendimento', null);
      created.push(`💬 Texto: **${publicChannel.name}**, **${staffChannel.name}**, **${logChannel.name}**`);

      const updates = {
        guild_id: guildId,
        category_id: category.id,
        wait_channel_id: waitChannel.id,
        attendance_channel_ids: attendanceChannels,
        public_channel_id: publicChannel.id,
        staff_channel_id: staffChannel.id,
        log_channel_id: logChannel.id,
      };

      if (interaction.options.getBoolean('criar_cargos')) {
        const staffRole = await ensureRole(guild, 'Staff VANTUS', COLORS.ORANGE);
        const adminRole = await ensureRole(guild, 'Admin VANTUS', COLORS.DANGER);
        updates.staff_role_ids = [staffRole.id];
        updates.admin_role_ids = [adminRole.id];
        created.push(`🛡️ Cargos: **${staffRole.name}**, **${adminRole.name}**`);
      }

      await services.settings.setMany(updates);

      const published = [];
      for (const [key, channel] of [
        ['public', publicChannel],
        ['staff', staffChannel],
      ]) {
        const result = await services.panels.publish(guildId, key, channel.id);
        published.push(`${key === 'public' ? '📋 Painel público' : '🛡️ Painel da staff'} em <#${channel.id}> (${result.mode})`);
      }

      const warnings = [];
      if ((services.settings.get('staff_role_ids') || []).length === 0) {
        warnings.push(
          '⚠️ Nenhum **cargo de staff** configurado — o painel da equipe ficará restrito a administradores.',
        );
      }
      if ((services.settings.get('admin_role_ids') || []).length === 0) {
        warnings.push('⚠️ Nenhum **cargo administrativo** configurado.');
      }
      if (warnings.length > 0) {
        created.push('', ...warnings);
      }

      await services.audit.log({
        guildId,
        type: 'SETUP',
        actorId: interaction.user.id,
        actorTag: interaction.member.displayName,
        message: `🏗️ <@${interaction.user.id}> executou o **/setup** e criou/atualizou a estrutura da central.`,
        color: COLORS.SUCCESS,
      });

      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '🏗️ Estrutura preparada',
              description: [...created, '', ...published].join('\n'),
              color: COLORS.SUCCESS,
              fields: [
                {
                  name: 'Próximos passos',
                  value:
                    '1. Confirme os IDs com `/diagnostico`.\n2. Ajuste os horários com `/horario ver`.\n3. Configure os cargos com `/config definir` se necessário.\n4. Publique novamente os painéis com `/painel publicar` após mudanças.',
                },
              ],
            }),
          ],
        }),
      );
    } catch (error) {
      return respondError(interaction, error);
    }
  },
};

async function deferSafe(interaction) {
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferReply({ flags: 64 }).catch(() => null);
}

async function ensureRole(guild, name, color) {
  const existing = guild.roles.cache.find((role) => role.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  return guild.roles.create({ name, color, reason: 'Setup da central VANTUS' });
}
