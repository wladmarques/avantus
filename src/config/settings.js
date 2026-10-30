'use strict';

/**
 * Definição de todas as configurações editáveis em tempo de execução.
 * Nada aqui exige alterar código: os valores ficam no banco e podem ser
 * trocados pelo painel/ comandos administrativos.
 */
const { isValidSchedule, isValidHHMM } = require('../utils/validators');

const DEFAULT_SCHEDULE = {
  mon: [{ open: '12:00', close: '02:00' }],
  tue: [{ open: '12:00', close: '02:00' }],
  wed: [{ open: '12:00', close: '02:00' }],
  thu: [{ open: '12:00', close: '02:00' }],
  fri: [{ open: '12:00', close: '02:00' }],
  sat: [{ open: '12:00', close: '00:00' }],
  sun: [{ open: '12:00', close: '00:00' }],
};

const asBool = (value) => value === true || value === 'true' || value === 1 || value === '1';
const asInt = (min, max) => (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < min || parsed > max) return null;
  return parsed;
};
const asIdList = (value) => (Array.isArray(value) && value.every((v) => /^\d{17,20}$/.test(String(v))));

const SETTINGS = {
  guild_id: {
    default: null,
    type: 'string',
    label: 'ID do servidor',
    group: 'Identidade',
    validate: (v) => (v === null || /^\d{17,20}$/.test(String(v))),
  },
  public_channel_id: {
    default: null,
    type: 'string',
    label: 'Canal do painel público',
    group: 'Canais',
  },
  staff_channel_id: {
    default: null,
    type: 'string',
    label: 'Canal do painel da staff',
    group: 'Canais',
  },
  log_channel_id: {
    default: null,
    type: 'string',
    label: 'Canal de logs administrativos',
    group: 'Canais',
  },
  category_id: {
    default: null,
    type: 'string',
    label: 'Categoria CENTRAL DE ATENDIMENTO',
    group: 'Canais',
  },
  wait_channel_id: {
    default: null,
    type: 'string',
    label: 'Canal de voz AGUARDANDO ATENDIMENTO',
    group: 'Canais',
  },
  attendance_channel_ids: {
    default: [],
    type: 'json',
    label: 'Canais de voz de atendimento',
    group: 'Canais',
    validate: asIdList,
  },
  staff_role_ids: {
    default: [],
    type: 'json',
    label: 'Cargos de staff',
    group: 'Permissões',
    validate: asIdList,
  },
  admin_role_ids: {
    default: [],
    type: 'json',
    label: 'Cargos administrativos',
    group: 'Permissões',
    validate: asIdList,
  },
  schedule: {
    default: DEFAULT_SCHEDULE,
    type: 'json',
    label: 'Horário de funcionamento',
    group: 'Funcionamento',
    validate: isValidSchedule,
  },
  central_manual: {
    default: 'auto',
    type: 'string',
    label: 'Estado manual da central (auto/open/closed)',
    group: 'Funcionamento',
    validate: (v) => ['auto', 'open', 'closed'].includes(v),
  },
  queue_policy_on_close: {
    default: 'keep',
    type: 'string',
    label: 'Fila ao fechar a central (keep/clear)',
    group: 'Funcionamento',
    validate: (v) => ['keep', 'clear'].includes(v),
  },
  max_queue_size: {
    default: 0,
    type: 'number',
    label: 'Tamanho máximo da fila (0 = ilimitado)',
    group: 'Fila',
    validate: asInt(0, 500),
  },
  max_wait_minutes: {
    default: 0,
    type: 'number',
    label: 'Tempo limite de espera em minutos (0 = sem limite)',
    group: 'Fila',
    validate: asInt(0, 600),
  },
  skip_policy: {
    default: 'end',
    type: 'string',
    label: 'Política de jogador pulado (end/hold)',
    group: 'Fila',
    validate: (v) => ['end', 'hold'].includes(v),
  },
  presence_timeout_minutes: {
    default: 5,
    type: 'number',
    label: 'Tempo para o jogador comparecer (min)',
    group: 'Atendimento',
    validate: asInt(1, 60),
  },
  no_show_policy: {
    default: 'requeue',
    type: 'string',
    label: 'Jogador não compareceu (requeue/close)',
    group: 'Atendimento',
    validate: (v) => ['requeue', 'close'].includes(v),
  },
  voice_disconnect_grace_seconds: {
    default: 120,
    type: 'number',
    label: 'Tolerância de desconexão de voz (s)',
    group: 'Atendimento',
    validate: asInt(30, 1800),
  },
  allow_staff_multi: {
    default: false,
    type: 'boolean',
    label: 'Permitir staff em múltiplos atendimentos',
    group: 'Atendimento',
    validate: asBool,
  },
  staff_auto_available: {
    default: true,
    type: 'boolean',
    label: 'Staff volta a DISPONÍVEL ao finalizar',
    group: 'Atendimento',
    validate: asBool,
  },
  notifications_position_change: {
    default: true,
    type: 'boolean',
    label: 'Avisar jogador quando a posição mudar',
    group: 'Notificações',
    validate: asBool,
  },
  position_notify_cooldown_minutes: {
    default: 10,
    type: 'number',
    label: 'Intervalo mínimo entre avisos de posição (min)',
    group: 'Notificações',
    validate: asInt(1, 240),
  },
  evaluations_enabled: {
    default: true,
    type: 'boolean',
    label: 'Enviar avaliação após o atendimento',
    group: 'Avaliações',
    validate: asBool,
  },
  panel_refresh_seconds: {
    default: 30,
    type: 'number',
    label: 'Atualização automática dos painéis (s)',
    group: 'Painéis',
    validate: asInt(10, 600),
  },
  average_wait_window_minutes: {
    default: 120,
    type: 'number',
    label: 'Janela para calcular espera média (min)',
    group: 'Painéis',
    validate: asInt(15, 1440),
  },
  stats_ranking_min_sample: {
    default: 3,
    type: 'number',
    label: 'Atendimentos mínimos para entrar no ranking',
    group: 'Relatórios',
    validate: asInt(1, 100),
  },
  hidden_channels: {
    default: false,
    type: 'boolean',
    label: 'Modo discreto (sem menções em canais)',
    group: 'Notificações',
    validate: asBool,
  },
  message_panel_title: {
    default: '🎧 ATENDIMENTO | VANTUS',
    type: 'string',
    label: 'Título do painel público',
    group: 'Mensagens',
    validate: (v) => typeof v === 'string' && v.length > 0 && v.length <= 120,
  },
  message_panel_description: {
    default:
      'Precisa de ajuda? Entre na fila de atendimento e aguarde a disponibilidade de um membro da nossa equipe.\n\nNosso sistema organizará automaticamente os atendimentos por ordem de chegada.',
    type: 'string',
    label: 'Descrição do painel público',
    group: 'Mensagens',
    validate: (v) => typeof v === 'string' && v.length > 0 && v.length <= 1500,
  },
  message_closed: {
    default: 'A central de atendimento está fechada no momento. Confira os horários de funcionamento abaixo.',
    type: 'string',
    label: 'Mensagem de central fechada',
    group: 'Mensagens',
    validate: (v) => typeof v === 'string' && v.length > 0 && v.length <= 500,
  },
};

const VALID_GROUPS = [...new Set(Object.values(SETTINGS).map((def) => def.group))];

/** Converte valor bruto (texto do banco/entrada) para o tipo do setting. */
function coerceValue(key, raw) {
  const def = SETTINGS[key];
  if (!def) return { ok: false, error: `Configuração "${key}" não existe.` };

  let value = raw;
  if (def.type === 'json' && typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'Valor JSON inválido.' };
    }
  }
  if (def.type === 'number' && typeof raw === 'string') value = Number.parseInt(raw, 10);
  if (def.type === 'boolean' && typeof raw === 'string') value = asBool(raw);

  if (def.validate && !def.validate(value)) {
    return { ok: false, error: `Valor inválido para ${def.label}.` };
  }
  return { ok: true, value };
}

/** Serializa para o banco (sempre JSON, preservando o tipo). */
function serializeValue(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function deserializeValue(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Conjunto de defaults para popular o banco na primeira execução. */
function defaultSettings() {
  const result = {};
  for (const [key, def] of Object.entries(SETTINGS)) result[key] = def.default;
  return result;
}

module.exports = {
  SETTINGS,
  VALID_GROUPS,
  DEFAULT_SCHEDULE,
  coerceValue,
  serializeValue,
  deserializeValue,
  defaultSettings,
  isValidHHMM,
};
