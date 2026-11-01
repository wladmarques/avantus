'use strict';

const { createLogger } = require('../../utils/logger');
const { buildPublicPanel } = require('../../dashboard/panels/publicPanel');
const { buildStaffPanel } = require('../../dashboard/panels/staffPanel');

const logger = createLogger('panels');

const PANEL_KEYS = { PUBLIC: 'public', STAFF: 'staff' };

/**
 * Publicação e atualização das mensagens persistentes.
 * A referência (canal + mensagem) fica no banco, então o bot sempre edita a
 * mesma mensagem — sem duplicar painéis após reinícios.
 */
class PanelService {
  constructor({ db, repo, gateway, settings, engine, statistics, schedule }) {
    this.db = db;
    this.repo = repo;
    this.gateway = gateway;
    this.settings = settings;
    this.engine = engine;
    this.statistics = statistics;
    this.schedule = schedule;
    this._pending = new Map();
    this._refreshing = new Set();
  }

  buildPayload(guildId, key) {
    const state = this.engine.getState(guildId);
    const openInfo = this.schedule.isOpen(guildId);
    const todayWindow = this.schedule.todayWindow(guildId);

    if (key === PANEL_KEYS.PUBLIC) {
      const settings = {
        ...this.settings.getAll(),
        estimateWaitSeconds: state.waiting.length ? this.engine.estimateWaitSeconds(state) : 0,
      };
      const built = buildPublicPanel({
        style: this.settings.get('panel_style'),
        settings,
        state,
        schedule: {
          ...openInfo,
          todayWindow,
          schedule: this.schedule.getSchedule(guildId),
        },
        iconUrl: this.gateway.guildIconUrl ? this.gateway.guildIconUrl(guildId) : null,
      });
      return { state, payload: built.payload, format: built.format };
    }

    const overview = this.statistics.todayOverview(guildId);
    return {
      state,
      payload: buildStaffPanel({ state, overview, schedule: openInfo, todayWindow }),
      format: 'embed',
    };
  }

  /** Publica (ou atualiza) um painel no canal informado. */
  async publish(guildId, key, channelId) {
    const existing = this.repo.getSync(guildId, key);
    let built = this.buildPayload(guildId, key);

    if (existing?.message_id) {
      const previousFormat = existing.format ?? 'embed';
      if (previousFormat === built.format) {
        try {
          await this.gateway.editMessage(guildId, existing.channel_id, existing.message_id, built.payload);
          return { ...existing, mode: 'edited' };
        } catch (error) {
          // 10008 = Unknown Message, 10003 = Unknown Channel: a mensagem não existe mais.
          const gone = error?.code === 10008 || error?.code === 10003;
          if (!gone) {
            logger.warn(`Falha ao editar o painel ${key}: ${error.message}`);
            throw error;
          }
          logger.warn(`Mensagem do painel ${key} não existe mais. Publicando uma nova.`);
        }
      } else {
        // Estilo mudou (embed <-> Components V2): a mensagem antiga é removida
        // para não ficarem dois painéis no canal.
        logger.info(`Layout do painel ${key} mudou (${previousFormat} → ${built.format}). Recriando.`);
        await this.gateway
          .deleteMessage(guildId, existing.channel_id, existing.message_id)
          .catch(() => null);
      }
    }

    let message;
    try {
      message = await this.gateway.sendChannelMessage(guildId, channelId, built.payload);
    } catch (error) {
      // Fallback: se o Discord recusar Components V2, publica o layout clássico.
      if (built.format === 'v2') {
        logger.warn(`Components V2 recusado (${error.message}). Publicando painel clássico.`);
        built = { ...built, ...buildPublicPanel({
          style: 'classic',
          settings: { ...this.settings.getAll(), estimateWaitSeconds: 0 },
          state: this.engine.getState(guildId),
          schedule: {
            ...this.schedule.isOpen(guildId),
            todayWindow: this.schedule.todayWindow(guildId),
          },
        }) };
        message = await this.gateway.sendChannelMessage(guildId, channelId, built.payload);
      } else {
        throw error;
      }
    }

    const saved = await this.db.transaction(async () =>
      this.repo.saveSync(guildId, key, {
        channelId,
        messageId: message.id,
        format: built.format,
      }),
    );
    return { ...saved, mode: 'created', format: built.format };
  }

  /** Reenvia o painel do zero (usado quando a mensagem foi apagada à mão). */
  async rebuild(guildId, key, channelId) {
    const existing = this.repo.getSync(guildId, key);
    if (existing?.message_id) {
      await this.gateway.deleteMessage(guildId, existing.channel_id, existing.message_id).catch(() => null);
    }
    await this.db.transaction(async () => this.repo.clearSync(guildId, key));
    const channel = channelId || existing?.channel_id || this.defaultChannel(key);
    if (!channel) throw new Error('Canal do painel não configurado.');
    const result = await this.publish(guildId, key, channel);
    this._requestAftermath(guildId);
    return result;
  }

  defaultChannel(key) {
    return key === PANEL_KEYS.PUBLIC
      ? this.settings.get('public_channel_id')
      : this.settings.get('staff_channel_id');
  }

  /** Atualização com debounce (evita rajadas de edições). */
  requestRefresh(guildId, { immediate = false } = {}) {
    this._requestAftermath(guildId, immediate);
  }

  _requestAftermath(guildId, immediate = false) {
    if (immediate) {
      this.refresh(guildId).catch((error) => logger.error('Falha ao atualizar painéis', error));
      return;
    }
    if (this._pending.has(guildId)) return;
    const timer = setTimeout(() => {
      this._pending.delete(guildId);
      this.refresh(guildId).catch((error) => logger.error('Falha ao atualizar painéis', error));
    }, 1200);
    timer.unref?.();
    this._pending.set(guildId, timer);
  }

  async refresh(guildId) {
    for (const key of Object.values(PANEL_KEYS)) {
      const existing = this.repo.getSync(guildId, key);
      if (!existing?.message_id) continue;
      try {
        const { payload, format } = this.buildPayload(guildId, key);
        if ((existing.format ?? 'embed') !== format) {
          // O layout configurado mudou: republica na próxima atualização.
          await this.publish(guildId, key, existing.channel_id);
          continue;
        }
        await this.gateway.editMessage(guildId, existing.channel_id, existing.message_id, payload);
      } catch (error) {
        logger.warn(`Falha ao atualizar painel ${key}: ${error.message}`);
      }
    }
  }

  /** Atualiza agora ou agenda (usado pelo domínio). */
  refreshOrRequest(guildId, { immediate = false } = {}) {
    if (immediate) {
      return this.refresh(guildId).catch((error) => logger.error('Falha ao atualizar painéis', error));
    }
    this._requestAftermath(guildId);
    return Promise.resolve();
  }

  /** Usado pelo /painel publicar. */
  async refreshBoth(guildId, { immediate = true } = {}) {
    if (immediate) await this.refresh(guildId);
    else this._requestAftermath(guildId);
  }
}

module.exports = { PanelService, PANEL_KEYS };
