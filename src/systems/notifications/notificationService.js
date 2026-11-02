'use strict';

const { card, DIVIDER } = require('../../dashboard/embeds/cards');
const { COLORS, BRAND } = require('../../config/theme');
const { formatTime, describeSchedule } = require('../../utils/time');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('notifications');

const RATING_BUTTONS = [
  { custom_id: 'eval:MUITO_BOM', label: 'Muito bom', emoji: { name: '⭐' }, style: 3 },
  { custom_id: 'eval:BOM', label: 'Bom', emoji: { name: '⭐' }, style: 1 },
  { custom_id: 'eval:REGULAR', label: 'Regular', emoji: { name: '⭐' }, style: 2 },
  { custom_id: 'eval:RUIM', label: 'Ruim', emoji: { name: '⭐' }, style: 4 },
];

/**
 * Mensagens privadas e avisos. Todos os métodos devolvem payloads JSON
 * prontos para envio pelo gateway.
 */
class NotificationService {
  constructor({ gateway, settings }) {
    this.gateway = gateway;
    this.settings = settings;
  }

  _send(userId, payload, guildId) {
    return this.gateway.sendDirectMessage(guildId, userId, payload).catch((error) => {
      logger.warn(`Falha ao enviar mensagem privada para ${userId}: ${error.message}`);
      return { ok: false, error };
    });
  }

  joinConfirmation({ guildId, userId, protocol, position, note = null }) {
    const embed = card({
      title: `${BRAND.icon} Você entrou na fila`,
      description: [
        'Você entrou na fila de atendimento da **VANTUS**.',
        '',
        `**Protocolo:** \`#${String(protocol).padStart(4, '0')}\``,
        `**Posição na fila:** ${position}º`,
        '',
        'Permaneça no canal de espera. Nossa equipe realizará seu atendimento assim que possível.',
        note ? `\n${note}` : null,
      ]
        .filter((line) => line !== null)
        .join('\n'),
      color: COLORS.ORANGE,
    });
    return this._send(userId, { embeds: [embed] }, guildId);
  }

  positionUpdate({ guildId, userId, protocol, position }) {
    const embed = card({
      title: '📢 Sua posição na fila mudou',
      description: [
        `**Protocolo:** \`#${String(protocol).padStart(4, '0')}\``,
        `**Nova posição:** ${position}º`,
        '',
        'Fique atento: em breve um membro da equipe irá te chamar.',
      ].join('\n'),
      color: COLORS.PURPLE,
    });
    return this._send(userId, { embeds: [embed] }, guildId);
  }

  called({ guildId, userId, protocol, channelName, staffName }) {
    const embed = card({
      title: '🔔 Seu atendimento foi iniciado!',
      description: [
        `**Protocolo:** \`#${String(protocol).padStart(4, '0')}\``,
        `**Atendente:** ${staffName ?? 'Equipe VANTUS'}`,
        channelName ? `**Canal:** 🔊 ${channelName}` : null,
        '',
        'Nossa equipe está aguardando você no canal de voz indicado.',
        'Dirija-se ao atendimento para continuar.',
      ]
        .filter(Boolean)
        .join('\n'),
      color: COLORS.SUCCESS,
    });
    return this._send(userId, { embeds: [embed] }, guildId);
  }

  requeued({ guildId, userId, protocol, position, reason }) {
    const embed = card({
      title: '🔄 Atendimento adiado',
      description: [
        'Seu atendimento precisou ser adiado pela equipe.',
        '',
        `**Protocolo:** \`#${String(protocol).padStart(4, '0')}\``,
        `**Nova posição:** ${position}º`,
        reason ? `**Motivo:** ${reason}` : null,
        '',
        'Você retornou para a fila e será chamado novamente em breve.',
      ]
        .filter(Boolean)
        .join('\n'),
      color: COLORS.WARNING,
    });
    return this._send(userId, { embeds: [embed] }, guildId);
  }

  removed({ guildId, userId, protocol, reason, cooldownMinutes = 0 }) {
    const embed = card({
      title: '🚫 Você saiu da fila',
      description: [
        `**Protocolo:** \`#${String(protocol).padStart(4, '0')}\``,
        reason ? `**Motivo:** ${reason}` : null,
        '',
        cooldownMinutes > 0
          ? `⏳ Você poderá entrar na fila novamente em **${cooldownMinutes} minutos**.`
          : 'Você pode entrar novamente na fila quando precisar.',
      ]
        .filter(Boolean)
        .join('\n'),
      color: COLORS.DANGER,
    });
    return this._send(userId, { embeds: [embed] }, guildId);
  }

  cooldownBlocked({ guildId, userId, remainingSeconds, minutes }) {
    const embed = card({
      title: '⏳ Aguarde para entrar novamente',
      description: [
        'Você saiu da fila antes de ser chamado.',
        '',
        `**Tempo restante:** ${this.formatRemaining(remainingSeconds)}`,
        minutes ? `**Bloqueio configurado:** ${minutes} minutos` : null,
        '',
        'Entre no canal de espera ou clique em **Entrar na fila** quando o tempo acabar.',
      ]
        .filter(Boolean)
        .join('\n'),
      color: COLORS.WARNING,
    });
    return this._send(userId, { embeds: [embed] }, guildId);
  }

  formatRemaining(seconds) {
    const total = Math.max(0, Math.ceil(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    if (minutes === 0) return `${rest}s`;
    return rest === 0 ? `${minutes}min` : `${minutes}min ${String(rest).padStart(2, '0')}s`;
  }

  noShow({ guildId, userId, protocol }) {
    const embed = card({
      title: '⌛ Não conseguimos te encontrar',
      description: [
        `Seu protocolo \`#${String(protocol).padStart(4, '0')}\` foi chamado, mas você não compareceu ao canal de voz.`,
        '',
        'Entre novamente na fila quando estiver disponível.',
      ].join('\n'),
      color: COLORS.WARNING,
    });
    return this._send(userId, { embeds: [embed] }, guildId);
  }

  centralClosed({ guildId, userId, schedule, nextOpen }) {
    const embed = card({
      title: '🔒 Central de atendimento fechada',
      description: [
        this.settings.get('message_closed'),
        '',
        nextOpen ? `**Próxima abertura:** ${nextOpen}` : null,
        '',
        '**Horários de funcionamento**',
        describeSchedule(schedule ?? this.settings.get('schedule')),
      ]
        .filter((line) => line !== null)
        .join('\n'),
      color: COLORS.MUTED,
    });
    return this._send(userId, { embeds: [embed] }, guildId);
  }

  evaluationRequest({ guildId, userId, protocol, staffName, attendanceId }) {
    const embed = card({
      title: '⭐ Como foi seu atendimento?',
      description: [
        'Como foi seu atendimento pela equipe **VANTUS**?',
        '',
        `**Protocolo:** \`#${String(protocol).padStart(4, '0')}\``,
        staffName ? `**Atendente:** ${staffName}` : null,
        '',
        'Sua opinião ajuda a melhorar cada vez mais o nosso atendimento.',
      ]
        .filter(Boolean)
        .join('\n'),
      color: COLORS.ORANGE,
      footer: `${BRAND.name} • Avaliação do atendimento`,
    });
    const buttons = RATING_BUTTONS.map((button) => ({
      ...button,
      custom_id: `eval:${attendanceId}:${button.custom_id.split(':')[1]}`,
    }));
    return this._send(
      userId,
      { embeds: [embed], components: [{ type: 1, components: buttons }] },
      guildId,
    );
  }

  /** Aviso ao staff antes do início do turno (banco de horas). */
  shiftReminder({ guildId, userId, shift, startsAt, minutesAhead }) {
    const embed = card({
      title: '⏰ Seu turno começa em breve',
      description: [
        `**Turno:** ${shift.weekdayLabel} • ${shift.start} às ${shift.end}`,
        `**Início:** ${formatTime(new Date(startsAt))} (em ${minutesAhead} minuto(s))`,
        '',
        'Entre no canal de voz de atendimento e fique **disponível** para começar a contar as suas horas.',
        'Se não puder comparecer, avise a administração.',
      ].join('\n'),
      color: COLORS.WARNING,
    });
    return this._send(userId, { embeds: [embed] }, guildId);
  }

  /** Aviso ao jogador quando a entrada automática pela voz não deu certo. */
  voiceJoinFailed({ guildId, userId, reason }) {
    const embed = card({
      title: '⚠️ Não foi possível entrar na fila',
      description: [
        'Você entrou no canal de espera, mas **não consegui te colocar na fila**.',
        '',
        reason ? `**Motivo:** ${reason}` : null,
        '',
        'Tente novamente pelo botão **Entrar na Fila** no painel ou use `/entrar`.',
        'Se o problema continuar, avise a equipe.',
      ]
        .filter((line) => line !== null)
        .join('\n'),
      color: COLORS.WARNING,
    });
    return this._send(userId, { embeds: [embed] }, guildId);
  }

  /** Aviso no canal de espera / painel público (texto curto, sem spam). */
  async announce(guildId, channelId, content) {
    if (!channelId) return;
    try {
      await this.gateway.sendChannelMessage(guildId, channelId, { content });
    } catch (error) {
      logger.warn(`Falha ao anunciar em ${channelId}: ${error.message}`);
    }
  }

  divider() {
    return DIVIDER;
  }
}

module.exports = { NotificationService, RATING_BUTTONS };
