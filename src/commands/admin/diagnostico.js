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

  async execute({ interaction, services, client, env }) {
    const context_env_client_id = () => env?.clientId ?? null;
    const guildId = interaction.guildId;
    const discord = client ?? interaction.client;
    const guild = discord?.guilds?.cache?.get(guildId);
    const settings = services.settings.getAll();
    const checks = [];

    const push = (ok, label, detail = '') => checks.push(`${ok ? '✅' : '⚠️'} **${label}**${detail ? ` — ${detail}` : ''}`);

    push(Boolean(settings.guild_id), 'Servidor configurado', settings.guild_id ?? 'use /config definir');

    // Bot conectado × CLIENT_ID configurado (troca de bot).
    const botUser = discord?.user;
    if (botUser) {
      const expected = (context_env_client_id() || '').trim();
      const matches = !expected || expected === botUser.id;
      push(
        matches,
        'Bot conectado',
        `${botUser.tag ?? botUser.username} (${botUser.id})` +
          (matches ? '' : ` — CLIENT_ID configurado é ${expected}, o token é de outro bot`),
      );
    }

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

    const availability = services.engine.availability(guildId);
    push(
      availability.available,
      'Entrada na fila liberada',
      availability.available
        ? `${availability.availableStaff} staff(s) disponível(is)`
        : availability.reason === 'sem_staff'
          ? 'bloqueada: nenhum staff disponível (botão do painel desabilitado)'
          : 'bloqueada: fora do horário de atendimento (botão do painel desabilitado)',
    );

    const autoJoin = settings.auto_queue_on_voice_join;
    push(
      autoJoin === true,
      'Entrada automática pelo canal de espera',
      autoJoin === true
        ? 'ligada'
        : 'DESLIGADA — use `/config definir` para ligar (sem isso, só o botão Entrar na Fila funciona)',
    );

    push(true, 'Saída automática ao sair do canal de espera', 'sempre ativa (sai da fila na hora)');

    const holdCount = services.repositories.attendance.countByStatusSync(guildId, 'hold');
    push(
      holdCount === 0,
      'Registros pendentes (hold)',
      holdCount === 0 ? 'nenhum' : `${holdCount} jogador(es) — eles não entram na fila automaticamente`,
    );

    // ---- banco de horas ----
    const openSessions = services.repositories.hourBank.listOpenSync(guildId).length;
    const scheduledStaff = new Set(services.hourBank.listShifts(guildId).map((shift) => shift.userId)).size;
    push(
      services.hourBank.enabled,
      'Banco de horas',
      services.hourBank.enabled
        ? `${openSessions} sessão(ões) aberta(s) • ${scheduledStaff} staff(s) com escala • aviso ${services.hourBank.reminderMinutes} min antes`
        : 'desligado',
    );
    push(
      Boolean(services.webPanel?.enabled ?? null),
      'Painel web do banco de horas',
      services.webPanel?.enabled
        ? `ativo na porta ${services.webPanel.port}`
        : 'desligado (defina WEB_PANEL_PASSWORD no .env)',
    );

    // ---- EQUIPE do painel (filtro por cargo) ----
    const roleCache = services.staff.roleCacheInfo?.(guildId) ?? null;
    if (roleCache) {
      const filtered = (roleCache.roleIds || []).length > 0;
      push(
        !filtered || (roleCache.synced && !roleCache.error),
        'EQUIPE do painel (cargos)',
        !filtered
          ? 'sem filtro — todos os staff registrados aparecem'
          : roleCache.error
            ? `última sincronização falhou (${roleCache.error}); o painel segue com a lista anterior`
            : `${roleCache.members} membro(s) com o cargo • sincronizado há ${roleCache.ageSeconds ?? 0}s`,
      );
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
