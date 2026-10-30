'use strict';

/**
 * Gateway do Discord: único ponto que fala com a API do Discord.
 * O domínio (fila/atendimento) depende apenas desta interface, o que
 * permite testar as regras de negócio com um gateway falso.
 */
const { createLogger } = require('../utils/logger');

const logger = createLogger('gateway');

class DiscordGateway {
  constructor(client, { settings }) {
    this.client = client;
    this.settings = settings;
  }

  _guild(guildId) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error(`Guild ${guildId} não encontrada no cache do bot.`);
    return guild;
  }

  async _fetchMember(guildId, userId) {
    if (!userId) return null;
    const guild = this._guild(guildId);
    let member = guild.members.cache.get(userId);
    if (!member) {
      member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
    }
    return member;
  }

  /* ------------------------------------------------------------------ */
  /* Membros e voz                                                       */
  /* ------------------------------------------------------------------ */

  async getMember(guildId, userId) {
    try {
      const member = await this._fetchMember(guildId, userId);
      if (!member) return { inGuild: false, voiceChannelId: null, displayName: null };
      return {
        inGuild: true,
        voiceChannelId: member.voice?.channelId ?? null,
        displayName: member.displayName || member.user.username,
        username: member.user.username,
        tag: member.user.tag,
        staffRoles: member.roles?.cache?.map((role) => role.id) ?? [],
      };
    } catch (error) {
      logger.warn(`getMember falhou (${guildId}/${userId}): ${error.message}`);
      return { inGuild: false, voiceChannelId: null, displayName: null };
    }
  }

  async getStaffVoiceState(guildId, staffId) {
    const member = await this._fetchMember(guildId, staffId);
    if (!member) return { connected: false, channelId: null, isAttendanceChannel: false };

    const channelId = member.voice?.channelId ?? null;
    if (!channelId) return { connected: false, channelId: null, isAttendanceChannel: false };

    const channel = member.voice.channel ?? (await this._guild(guildId).channels.fetch(channelId).catch(() => null));
    const allowed = this.settings.get('attendance_channel_ids') || [];
    const categoryId = this.settings.get('category_id');

    const isAttendanceChannel =
      allowed.includes(channelId) ||
      (Boolean(channel?.parentId) && channel.parentId === categoryId);

    return {
      connected: true,
      channelId,
      channelName: channel?.name ?? null,
      parentId: channel?.parentId ?? null,
      isAttendanceChannel,
    };
  }

  /** Move o jogador para um canal de voz quando ele está conectado. */
  async moveToVoiceChannel(guildId, userId, channelId, { force = false } = {}) {
    if (!channelId) return { moved: false, reason: 'canal não configurado' };
    const member = await this._fetchMember(guildId, userId);
    if (!member) return { moved: false, reason: 'membro não encontrado' };
    if (!member.voice?.channelId) return { moved: false, reason: 'jogador não está em canal de voz' };
    if (member.voice.channelId === channelId) return { moved: false, reason: 'já está no canal' };

    if (!force) {
      const allowed = this.settings.get('attendance_channel_ids') || [];
      const waitChannel = this.settings.get('wait_channel_id');
      const targetOk = channelId === waitChannel || allowed.includes(channelId);
      if (!targetOk) {
        logger.warn('Movimentação bloqueada para canal fora da central de atendimento.');
        return { moved: false, reason: 'canal fora da central' };
      }
    }

    try {
      await member.voice.setChannel(channelId, 'Central de atendimento VANTUS');
      return { moved: true, channelId };
    } catch (error) {
      logger.warn(`Falha ao mover ${userId}: ${error.message}`);
      return { moved: false, reason: error.message };
    }
  }

  async grantVoiceAccess(guildId, channelId, userId) {
    if (!channelId || !userId) return false;
    const channel = await this._guild(guildId).channels.fetch(channelId).catch(() => null);
    if (!channel) return false;
    await channel.permissionOverwrites.edit(
      userId,
      { ViewChannel: true, Connect: true, Speak: true },
      { reason: 'Atendimento VANTUS em andamento' },
    );
    return true;
  }

  async revokeVoiceAccess(guildId, channelId, userId) {
    if (!channelId || !userId) return false;
    const channel = await this._guild(guildId).channels.fetch(channelId).catch(() => null);
    if (!channel) return false;
    await channel.permissionOverwrites.delete(userId, 'Atendimento VANTUS encerrado').catch(() => null);
    return true;
  }

  /**
   * Desconecta o membro do canal de voz atual (se estiver conectado).
   * Usado quando o jogador sai da fila/atendimento.
   */
  async disconnectFromVoice(guildId, userId) {
    const member = await this._fetchMember(guildId, userId);
    if (!member?.voice?.channelId) return false;
    try {
      await member.voice.disconnect('Atendimento VANTUS encerrado');
      return true;
    } catch (error) {
      logger.warn(`Falha ao desconectar ${userId}: ${error.message}`);
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Mensagens                                                           */
  /* ------------------------------------------------------------------ */

  async sendDirectMessage(guildId, userId, payload) {
    const user = await this.client.users.fetch(userId).catch(() => null);
    if (!user) return { ok: false, reason: 'usuário não encontrado' };
    try {
      const channel = await user.createDM();
      return await channel.send(payload);
    } catch (error) {
      logger.warn(`DM bloqueada para ${userId}: ${error.message}`);
      return { ok: false, reason: error.message };
    }
  }

  async sendChannelMessage(guildId, channelId, payload) {
    if (!channelId) throw new Error('Canal não configurado.');
    const channel = await this._guild(guildId).channels.fetch(channelId);
    if (!channel?.isTextBased?.()) throw new Error('Canal informado não é de texto.');
    return channel.send(payload);
  }

  async editMessage(guildId, channelId, messageId, payload) {
    const channel = await this._guild(guildId).channels.fetch(channelId);
    if (!channel) throw new Error('Canal não encontrado.');
    const message = await channel.messages.fetch(messageId);
    return message.edit(payload);
  }

  async deleteMessage(guildId, channelId, messageId) {
    const channel = await this._guild(guildId).channels.fetch(channelId).catch(() => null);
    if (!channel) return false;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return false;
    await message.delete();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Estrutura do servidor (usada pelo /setup)                           */
  /* ------------------------------------------------------------------ */

  async ensureCategory(guildId, name) {
    const guild = this._guild(guildId);
    const existing = guild.channels.cache.find(
      (channel) => channel.type === 4 && channel.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) return existing;
    return guild.channels.create({ name, type: 4 });
  }

  async ensureVoiceChannel(guildId, name, categoryId) {
    const guild = this._guild(guildId);
    const existing = guild.channels.cache.find(
      (channel) => channel.type === 2 && channel.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) return existing;
    return guild.channels.create({ name, type: 2, parent: categoryId });
  }

  async ensureTextChannel(guildId, name, categoryId) {
    const guild = this._guild(guildId);
    const existing = guild.channels.cache.find(
      (channel) => channel.type === 0 && channel.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) return existing;
    return guild.channels.create({ name, type: 0, parent: categoryId });
  }

  async findRoleByName(guildId, name) {
    const guild = this._guild(guildId);
    return guild.roles.cache.find((role) => role.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  async countMembersWithRole(guildId, roleIds) {
    if (!roleIds?.length) return 0;
    const guild = this._guild(guildId);
    await guild.members.fetch().catch(() => null);
    return guild.members.cache.filter((member) =>
      roleIds.some((roleId) => member.roles.cache.has(roleId)),
    ).size;
  }

  async fetchChannel(guildId, channelId) {
    return this._guild(guildId).channels.fetch(channelId).catch(() => null);
  }
}

/** Gateway em memória — usado nos testes automatizados. */
class MemoryGateway {
  constructor({ settings, members = {}, voice = {} } = {}) {
    this.settings = settings;
    this.members = new Map(Object.entries(members));
    this.staffVoice = new Map(Object.entries(voice));
    this.dms = [];
    this.channelMessages = [];
    this.moves = [];
    this.access = [];
    this.disconnects = [];
    this.deletedMessages = [];
    this.messageSeq = 0;
  }

  async getMember(guildId, userId) {
    const entry = this.members.get(userId);
    if (!entry || entry.inGuild === false) return { inGuild: false, voiceChannelId: null };
    return {
      inGuild: true,
      voiceChannelId: entry.voiceChannelId ?? null,
      displayName: entry.displayName ?? `Jogador ${userId}`,
    };
  }

  async getStaffVoiceState(guildId, staffId) {
    const entry = this.staffVoice.get(staffId);
    const allowed = this.settings.get('attendance_channel_ids') || [];
    if (!entry || !entry.channelId) return { connected: false, channelId: null, isAttendanceChannel: false };
    return {
      connected: true,
      channelId: entry.channelId,
      channelName: entry.channelName ?? 'ATENDIMENTO',
      isAttendanceChannel: allowed.includes(entry.channelId) || entry.channelId === 'att-1',
    };
  }

  async moveToVoiceChannel(guildId, userId, channelId) {
    this.moves.push({ userId, channelId });
    return { moved: true, channelId };
  }

  async grantVoiceAccess(guildId, channelId, userId) {
    this.access.push({ action: 'grant', channelId, userId });
    return true;
  }

  async revokeVoiceAccess(guildId, channelId, userId) {
    this.access.push({ action: 'revoke', channelId, userId });
    return true;
  }

  async disconnectFromVoice(guildId, userId) {
    this.disconnects.push({ userId });
    return true;
  }

  async sendDirectMessage(guildId, userId, payload) {
    this.dms.push({ userId, payload });
    return { ok: true, id: `dm-${this.dms.length}` };
  }

  async sendChannelMessage(guildId, channelId, payload) {
    this.messageSeq += 1;
    const message = { id: `msg-${this.messageSeq}`, channelId, payload };
    this.channelMessages.push(message);
    return message;
  }

  async editMessage(guildId, channelId, messageId, payload) {
    const message = this.channelMessages.find((item) => item.id === messageId);
    if (!message) throw new Error('Mensagem inexistente');
    message.payload = payload;
    return message;
  }

  async deleteMessage(guildId, channelId, messageId) {
    this.deletedMessages.push(messageId);
    return true;
  }
}

module.exports = { DiscordGateway, MemoryGateway };
