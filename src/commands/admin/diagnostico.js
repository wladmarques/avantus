'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, GatewayIntentBits } = require('discord.js');
const { respond, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');
const { formatTime } = require('../../utils/time');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('diagnostico')
    .setDescription('Verifica a configuração, canais e permissões do bot'),

  async execute({ interaction, services, client }) {
    const guildId = interaction.guildId;
    const discord = client ?? interaction.client;
    const guild = discord?.guilds?.cache?.get(guildId);
    const settings = services.settings.getAll();
    const checks = [];

    const push = (ok, label, detail = '') => checks.push(`${ok ? '✅' : '⚠️'} **${label}**${detail ? ` — ${detail}` : ''}`);

    push(Boolean(settings.guild_id), 'Servidor configurado', settings.guild_id ?? 'use /config definir');

    const channelCheck = async (id, name, expectedType) => {
      if (!id) return push(false, name, 'não configurado');
      const channel = await services.gateway.fetchChannel(guildId, id);
      if (!channel) return push(false, name, `canal ${id} não encontrado`);
      if (expectedType && channel.type !== expectedType) {
        return push(false, name, 'tipo de canal incorreto');
      }
      return push(true, name, `<#${id}>`);
    };

    await channelCheck(settings.public_channel_id, 'Painel público', 0);
    await channelCheck(settings.staff_channel_id, 'Painel da staff', 0);
    await channelCheck(settings.log_channel_id, 'Canal de logs', 0);
    await channelCheck(settings.wait_channel_id, 'Canal de espera', 2);
    await channelCheck(settings.category_id, 'Categoria de atendimento', 4);

    if (settings.attendance_channel_ids.length === 0) {
      push(false, 'Canais de atendimento', 'nenhum configurado');
    } else {
      let ok = 0;
      for (const id of settings.attendance_channel_ids) {
        const channel = await services.gateway.fetchChannel(guildId, id);
        if (channel?.type === 2) ok += 1;
      }
      push(ok === settings.attendance_channel_ids.length, 'Canais de atendimento', `${ok}/${settings.attendance_channel_ids.length} válidos`);
    }

    // ---- fila por voz (entrada automática ao entrar no canal de espera) ----
    const currentGuildId = interaction.guildId;
    if (settings.guild_id && settings.guild_id !== currentGuildId) {
      push(
        false,
        'Servidor do evento de voz',
        `guild_id configurado (${settings.guild_id}) é diferente deste servidor — a fila por voz é ignorada`,
      );
    }

    const voiceIntent = discord?.options?.intents;
    const hasVoiceIntent = Boolean(voiceIntent?.has?.(GatewayIntentBits.GuildVoiceStates));
    push(hasVoiceIntent, 'Evento de voz (GuildVoiceStates)', hasVoiceIntent ? 'ativo' : 'AUSENTE — ative no código/portal');

    const autoJoin = settings.auto_queue_on_voice_join;
    push(
      autoJoin === true,
      'Entrada automática pelo canal de espera',
      autoJoin === true
        ? 'ligada'
        : 'DESLIGADA — use `/config definir` para ligar (sem isso, só o botão Entrar na Fila funciona)',
    );

    push(
      settings.leave_queue_on_wait_exit === true,
      'Saída automática ao sair do canal de espera',
      settings.leave_queue_on_wait_exit === true ? 'ligada' : 'desligada',
    );

    const cooldownMinutes = Number(settings.rejoin_cooldown_minutes) || 0;
    push(
      true,
      'Bloqueio de reentrada',
      cooldownMinutes > 0 ? `${cooldownMinutes} min após desistir antes de ser chamado` : 'desligado',
    );

    const holdCount = services.repositories.attendance.countByStatusSync(guildId, 'hold');
    push(
      holdCount === 0,
      'Registros pendentes (hold)',
      holdCount === 0 ? 'nenhum' : `${holdCount} jogador(es) — eles não entram na fila automaticamente`,
    );

    const blocked = services.repositories.cooldowns.listActiveSync(guildId);
    if (blocked.length > 0) {
      push(false, 'Jogadores em bloqueio', `${blocked.length} aguardando liberar`);
    }

    push(settings.staff_role_ids.length > 0, 'Cargos de staff', `${settings.staff_role_ids.length} configurado(s)`);
    push(settings.admin_role_ids.length > 0, 'Cargos administrativos', `${settings.admin_role_ids.length} configurado(s)`);

    const me = guild?.members.me;
    if (me) {
      const perms = me.permissions;
      const required = [
        ['Gerenciar canais', PermissionFlagsBits.ManageChannels],
        ['Mover membros', PermissionFlagsBits.MoveMembers],
        ['Conectar', PermissionFlagsBits.Connect],
        ['Enviar mensagens', PermissionFlagsBits.SendMessages],
        ['Inserir links', PermissionFlagsBits.EmbedLinks],
      ];
      const missing = required.filter(([, flag]) => !perms.has(flag)).map(([name]) => name);
      push(missing.length === 0, 'Permissões do bot', missing.length ? `faltando: ${missing.join(', ')}` : 'ok');
    }

    const panels = {
      public: services.repositories.panels.getSync(guildId, 'public'),
      staff: services.repositories.panels.getSync(guildId, 'staff'),
    };
    push(Boolean(panels.public?.message_id), 'Painel público publicado', panels.public ? `<#${panels.public.channel_id}>` : 'use /painel publicar');
    push(Boolean(panels.staff?.message_id), 'Painel staff publicado', panels.staff ? `<#${panels.staff.channel_id}>` : 'use /painel publicar');

    const state = services.engine.getState(guildId);
    const stats = services.db.get('SELECT COUNT(*) AS total FROM attendance');
    const auditCount = services.db.get('SELECT COUNT(*) AS total FROM audit_events');

    return respond(
      interaction,
      ephemeral({
        embeds: [
          card({
            title: '🩺 Diagnóstico do sistema',
            description: checks.join('\n'),
            color: COLORS.INFO,
            fields: [
              { name: 'Central', value: `${services.central.status(guildId).label} • ${formatTime()}`, inline: true },
              { name: 'Fuso', value: 'America/Sao_Paulo', inline: true },
              { name: 'Fila', value: `${state.waiting.length} aguardando / ${state.serving.length} ativos`, inline: true },
              { name: 'Registros', value: `${stats?.total ?? 0} protocolos • ${auditCount?.total ?? 0} eventos`, inline: false },
              { name: 'Banco', value: `\`${services.db.filePath}\``, inline: false },
            ],
            footer: 'Execute /painel publicar se algum painel estiver ausente.',
          }),
        ],
      }),
    );
  },
};
