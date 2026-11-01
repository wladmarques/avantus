'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');

/**
 * Nomes padrão criados pelo /setup (identidade VANTUS: emoji + separador "・").
 * Os nomes anteriores são aceitos como apelido para não duplicar canais.
 */
const TEXT = {
  public: 'central-atendimento',
  publicLegacy: ['💬・central-atendimento'],
  staff: 'painel-staff',
  staffLegacy: ['💼・painel-staff'],
  log: 'logs-atendimento',
  logLegacy: ['📋・logs-atendimento'],
};

const STRUCTURE = {
  category: { name: '🎧・central de atendimento', legacy: ['CENTRAL DE ATENDIMENTO'] },
  wait: { name: '⏳・aguardando-atendimento', legacy: ['AGUARDANDO ATENDIMENTO'] },
  attendance: [
    { name: '🔉・suporte¹', legacy: ['ATENDIMENTO 01'] },
    { name: '🔉・suporte²', legacy: ['ATENDIMENTO 02'] },
    { name: '🔉・suporte³', legacy: ['ATENDIMENTO 03'] },
  ],
};

const CHANNEL_TYPE_ID = { category: 4, voice: 2, text: 0 };

/**
 * Garante o canal com o **nome novo** e devolve `{ channel, renamed }`.
 *
 * Se o canal já existe com o nome novo (ou com um nome equivalente, sem o
 * prefixo de emoji), ele é reaproveitado. Se existir apenas com um nome antigo
 * (`AGUARDANDO ATENDIMENTO`, `ATENDIMENTO 01`…), o canal é **renomeado** — assim
 * rodar o `/setup` de novo atualiza o servidor sem criar duplicatas.
 */
async function ensureChannel(gateway, { guildId, name, legacy = [], type, categoryId = null }) {
  const typeId = CHANNEL_TYPE_ID[type];
  const create = () =>
    type === 'category'
      ? gateway.ensureCategory(guildId, name, categoryId)
      : type === 'text'
        ? gateway.ensureTextChannel(guildId, name, categoryId)
        : gateway.ensureVoiceChannel(guildId, name, categoryId);

  const find = async (value) =>
    typeof gateway.findChannelByName === 'function'
      ? gateway.findChannelByName(guildId, value, typeId)
      : null;

  // Já existe com o nome atual?
  const current = await find(name);
  if (current) {
    if (current.name === name) return { channel: current, renamed: false };
    const renamed = await gateway.renameChannel(guildId, current.id, name);
    return { channel: renamed ?? current, renamed: Boolean(renamed) };
  }

  // Existe com algum nome anterior? Reaproveita e renomeia.
  for (const oldName of legacy) {
    const old = await find(oldName);
    if (!old) continue;
    const renamed = await gateway.renameChannel(guildId, old.id, name);
    if (renamed) return { channel: renamed, renamed: true };
  }

  return { channel: await create(), renamed: false };
}

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

      const renamed = [];

      const categoryResult = await ensureChannel(gateway, {
        guildId,
        name: STRUCTURE.category.name,
        legacy: STRUCTURE.category.legacy,
        type: 'category',
      });
      const category = categoryResult.channel;
      if (categoryResult.renamed) renamed.push(category.name);
      created.push(`📁 Categoria: **${category.name}**`);

      const waitResult = await ensureChannel(gateway, {
        guildId,
        name: STRUCTURE.wait.name,
        legacy: STRUCTURE.wait.legacy,
        type: 'voice',
        categoryId: category.id,
      });
      const waitChannel = waitResult.channel;
      if (waitResult.renamed) renamed.push(waitChannel.name);
      created.push(`🔊 Voz: **${waitChannel.name}**`);

      const attendanceChannels = [];
      for (const entry of STRUCTURE.attendance) {
        const result = await ensureChannel(gateway, {
          guildId,
          name: entry.name,
          legacy: entry.legacy,
          type: 'voice',
          categoryId: category.id,
        });
        attendanceChannels.push(result.channel.id);
        if (result.renamed) renamed.push(result.channel.name);
        created.push(`🔊 Voz: **${result.channel.name}**`);
      }

      const publicChannel = (await ensureChannel(gateway, {
        guildId,
        name: TEXT.public,
        legacy: TEXT.publicLegacy,
        type: 'text',
      })).channel;
      const staffChannel = (await ensureChannel(gateway, {
        guildId,
        name: TEXT.staff,
        legacy: TEXT.staffLegacy,
        type: 'text',
      })).channel;
      const logChannel = (await ensureChannel(gateway, {
        guildId,
        name: TEXT.log,
        legacy: TEXT.logLegacy,
        type: 'text',
      })).channel;
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
      if (renamed.length > 0) {
        created.push('', `♻️ Canais atualizados para o padrão novo: ${renamed.map((name) => `**${name}**`).join(', ')}`);
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
