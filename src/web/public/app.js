'use strict';

/**
 * Interface do painel web do banco de horas.
 * Consome a API do bot (mesma origem) — nenhuma dependência externa.
 */
(() => {
  const state = {
    staff: [],
    period: { from: '', to: '' },
    editing: null,
    renaming: null,
    offService: null,
    blocking: null,
    removing: null,
    evaluations: null,
    timer: null,
    // Grupo do revezamento da semana (A/B) — vem do /api/overview.
    weekParity: null,
  };

  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const fmtMinutes = (minutes) => {
    const value = Math.max(0, Math.round(Number(minutes) || 0));
    if (value < 60) return `${value} min`;
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, '0')}`;
  };

  const isoDay = (date) => {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  };

  const TOKEN_KEY = 'vantus_token';

  // Persistência do token, em três níveis (o primeiro disponível vence):
  //   1. memória   — sempre funciona;
  //   2. sessionStorage — navegador normal;
  //   3. hash da URL (#auth=…) — iframe de preview, onde storage e cookie de
  //      terceiros são bloqueados. Sem isso, cada reload derrubava a sessão
  //      ("Sessão expirada") logo depois do login.
  let memoryToken = '';

  const readStorage = () => {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  };

  const readHash = () => {
    const match = /(?:^#|&)auth=([^&]+)/.exec(window.location.hash || '');
    return match ? decodeURIComponent(match[1]) : '';
  };

  const writeHash = (token) => {
    try {
      const url = new URL(window.location.href);
      if (token) url.hash = `auth=${encodeURIComponent(token)}`;
      else url.hash = '';
      window.history.replaceState(null, '', url.toString());
    } catch {
      /* history indisponível: segue só com memória */
    }
  };

  const storageWorks = (() => {
    try {
      sessionStorage.setItem(`${TOKEN_KEY}_probe`, '1');
      sessionStorage.removeItem(`${TOKEN_KEY}_probe`);
      return true;
    } catch {
      return false;
    }
  })();

  const getToken = () => memoryToken || readStorage() || readHash();

  const setToken = (token) => {
    memoryToken = token || '';
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* sem armazenamento: o hash (ou a memória) resolve */
    }
    if (!storageWorks) writeHash(token);
    else writeHash('');
  };

  // Recupera a sessão de um reload anterior antes da primeira requisição.
  if (!memoryToken) memoryToken = readStorage() || readHash();

  /** Envia o token no header e, como reforço, na query (proxies que filtram headers). */
  const withToken = (path, token) => {
    if (!token) return path;
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}auth=${encodeURIComponent(token)}`;
  };

  async function api(path, options = {}) {
    // `auth: false` = rota pública (login): um 401 ali significa senha errada,
    // não sessão expirada — a mensagem do servidor deve chegar ao usuário.
    const { auth = true, ...init } = options;
    const token = getToken();
    const response = await fetch(withToken(path, token), {
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...init,
    });
    if (response.status === 401 && auth) {
      const hadToken = Boolean(token);
      setToken('');
      showLogin(
        hadToken
          ? 'Sessão expirada. Entre novamente.'
          : 'A sessão não foi mantida pelo navegador. Entre novamente.',
      );
      throw new Error('unauthorized');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Falha na requisição.');
    return data;
  }

  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(node._timer);
    node._timer = setTimeout(() => {
      node.hidden = true;
    }, 3200);
  }

  function showLogin(message) {
    $('app').hidden = true;
    $('login').hidden = false;
    const hint = $('login-hint');
    if (message) {
      const error = $('login-error');
      error.textContent = message;
      error.hidden = false;
      hint.hidden = false;
    } else {
      $('login-error').hidden = true;
      hint.hidden = true;
    }
    clearInterval(state.timer);
  }

  function showApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    // A tela de login sai do fluxo (hidden) e o painel começa no topo.
    try {
      window.scrollTo({ top: 0, behavior: 'instant' });
    } catch {
      /* scroll indisponível */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Período                                                             */
  /* ------------------------------------------------------------------ */

  function setPeriod(days) {
    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    $('from').value = isoDay(from);
    $('to').value = isoDay(now);
    for (const chip of $('period-buttons').querySelectorAll('.chip')) {
      chip.classList.toggle('active', Number(chip.dataset.days) === days);
    }
  }

  function periodQuery() {
    const from = $('from').value;
    const to = $('to').value;
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params.toString();
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  function statusDotClass(status) {
    if (status === 'DISPONIVEL') return 'dot on';
    if (status === 'EM_ATENDIMENTO') return 'dot busy';
    if (status === 'AUSENTE') return 'dot busy';
    return 'dot off';
  }

  // Turnos do dia de hoje que valem para o revezamento desta semana.
  function shiftsForToday(row) {
    const weekday = new Date().getDay();
    return (row.shifts || []).filter(
      (shift) => Number(shift.weekday) === weekday && (!shift.parity || shift.parity === state.weekParity),
    );
  }

  function shiftTextForToday(row) {
    if (row.currentShift) return `${row.currentShift.start} às ${row.currentShift.end}`;
    const today = shiftsForToday(row);
    if (today.length > 0) {
      return today.map((shift) => `${shift.start} às ${shift.end}`).join(' / ');
    }
    if (row.nextShift) {
      return `próximo: ${row.nextShift.start} (${row.nextShift.dayKey.slice(8, 10)}/${row.nextShift.dayKey.slice(5, 7)})`;
    }
    return 'sem escala';
  }

  function renderStaff(overview) {
    const body = $('staff-body');
    body.innerHTML = '';

    if (!overview.staff.length) {
      const row = el('tr');
      const cell = el('td', 'empty', 'Nenhum staff cadastrado. Use o botão “Editar escala” de um staff existente ou registre o staff pelo Discord.');
      cell.colSpan = 8;
      row.appendChild(cell);
      body.appendChild(row);
      return;
    }

    for (const row of overview.staff) {
      const tr = el('tr', 'clickable');
      tr.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        openSessions(row);
      });

      const who = el('td');
      const whoBox = el('div', 'who');
      whoBox.appendChild(
        row.staffName
          ? el('strong', null, row.staffName)
          : el('strong', 'unnamed', `Usuário ${row.userId}`),
      );
      whoBox.appendChild(el('span', null, row.userId));
      who.appendChild(whoBox);

      const status = el('td');
      const statusBox = el('span', 'status');
      statusBox.appendChild(el('span', statusDotClass(row.status)));
      statusBox.appendChild(el('span', null, row.session ? `EM SERVIÇO ${row.session.entry}` : row.statusLabel));
      if (row.blocked) {
        const badge = el('span', 'badge blocked', 'BLOQUEADO');
        badge.title = row.blockedReason ? `Motivo: ${row.blockedReason}` : 'Bloqueado de entrar em serviço';
        statusBox.appendChild(badge);
      }
      status.appendChild(statusBox);
      if (row.blocked) tr.classList.add('is-blocked');

      const shift = el('td', null, shiftTextForToday(row));
      const entry = el('td', null, row.session ? row.session.entry : row.totals.entryLabel);
      const exit = el('td', null, row.session ? '—' : row.totals.exitLabel);
      const hours = el('td', 'num', fmtMinutes(row.totals.minutes));
      const late = el('td', 'num');
      if (row.totals.lateCount > 0) {
        late.className = 'num late';
        late.textContent = `${row.totals.lateCount}× (${fmtMinutes(row.totals.lateMinutes)})`;
      } else {
        late.className = 'num ok';
        late.textContent = '—';
      }

      const actions = el('td', 'num');
      const rename = el('button', 'btn tiny', row.staffName ? 'Nome' : 'Definir nome');
      rename.addEventListener('click', () => openName(row));
      const edit = el('button', 'btn tiny', 'Editar escala');
      edit.addEventListener('click', () => openSchedule(row));
      actions.append(rename, edit);
      // Só faz sentido quando o staff está em serviço (sessão aberta ou disponível).
      if (row.session || row.available) {
        const off = el('button', 'btn tiny', 'Tirar de serviço');
        off.addEventListener('click', () => openOffService(row));
        actions.appendChild(off);
      }
      const block = el(
        'button',
        row.blocked ? 'btn tiny' : 'btn tiny danger',
        row.blocked ? 'Desbloquear' : 'Bloquear',
      );
      block.title = row.blocked
        ? 'Permitir que o staff volte a entrar em serviço'
        : 'Impedir que o staff entre em serviço';
      block.addEventListener('click', () =>
        row.blocked ? toggleBlock(row, false) : openBlock(row),
      );
      const remove = el('button', 'btn tiny danger', 'Remover');
      remove.addEventListener('click', () => openRemove(row));
      actions.append(block, remove);

      for (const cell of [who, status, shift, entry, exit, hours, late, actions]) tr.appendChild(cell);
      body.appendChild(tr);
    }
  }

  // Resumo de uma escala: dias úteis (mesmo horário) + fim de semana e grupo.
  function scheduleSummary(row) {
    const shifts = row.shifts || [];
    const weekdays = shifts.filter((shift) => Number(shift.weekday) >= 1 && Number(shift.weekday) <= 5);
    const weekends = shifts.filter((shift) => Number(shift.weekday) === 0 || Number(shift.weekday) === 6);
    const times = (list) => [...new Set(list.map((shift) => `${shift.start}–${shift.end}`))].join(' / ');
    return {
      weekdays: weekdays.length ? times(weekdays) : null,
      weekends: weekends.length ? times(weekends) : null,
      weekendGroup: weekends.find((shift) => shift.parity)?.parity ?? (weekends.length ? 'all' : null),
    };
  }

  function weekendGroupLabel(group) {
    if (group === 'all') return 'Todos os fins de semana';
    if (group === 'A' || group === 'B') return `Fim de semana ${group}`;
    return '—';
  }

  function renderScheduleList(staff) {
    const container = $('schedule-list');
    container.innerHTML = '';
    const withShifts = staff.filter((row) => row.shifts && row.shifts.length > 0);

    if (!withShifts.length) {
      container.appendChild(el('p', 'muted small', 'Nenhuma escala cadastrada ainda. Clique em “Editar escala” para definir os horários.'));
      return;
    }

    for (const row of withShifts) {
      const summary = scheduleSummary(row);
      const card = el('div', 'schedule-card');
      const title = el('h3');
      title.appendChild(el('span', null, row.staffName || row.userId));
      const edit = el('button', 'btn tiny', 'Editar');
      edit.addEventListener('click', () => openSchedule(row));
      title.appendChild(edit);
      card.appendChild(title);

      const list = el('ul');
      if (summary.weekdays) {
        const item = el('li');
        item.appendChild(el('span', null, 'Dias úteis'));
        item.appendChild(el('strong', null, summary.weekdays));
        list.appendChild(item);
      }
      if (summary.weekends) {
        const item = el('li');
        item.appendChild(el('span', null, weekendGroupLabel(summary.weekendGroup)));
        item.appendChild(el('strong', null, summary.weekends));
        list.appendChild(item);
      }
      card.appendChild(list);
      container.appendChild(card);
    }
  }

  function renderStats(overview) {
    const online = overview.staff.filter((row) => row.session).length;
    $('stat-staff').textContent = String(overview.staff.length);
    $('stat-online').textContent = String(online);
    $('stat-hours').textContent = fmtMinutes(overview.totals.minutes);
    $('stat-late').textContent = overview.totals.lateCount
      ? `${overview.totals.lateCount}× (${fmtMinutes(overview.totals.lateMinutes)})`
      : '—';
    $('updated').textContent = `Atualizado às ${new Date(overview.generatedAt).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }

  /* ------------------------------------------------------------------ */
  /* Fila e canal de espera (janela de reconexão)                        */
  /* ------------------------------------------------------------------ */

  function renderQueue(data) {
    const grace = data.waitGrace || {};
    $('wait-grace-enabled').checked = Boolean(grace.enabled);
    $('wait-grace-seconds').value = grace.seconds ?? 60;
    $('wait-grace-seconds').disabled = !grace.enabled;

    const players = data.players || [];
    $('queue-status').textContent = grace.enabled
      ? `aguardando reconexão por até ${grace.seconds}s`
      : 'remoção imediata (desligado)';

    const list = $('queue-grace-list');
    list.innerHTML = '';
    if (!grace.enabled) {
      $('queue-players').textContent = 'Nenhum jogador aguardando reconexão.';
      return;
    }
    if (!players.length) {
      $('queue-players').textContent = 'Nenhum jogador aguardando reconexão agora.';
      return;
    }
    $('queue-players').textContent = `${players.length} jogador(es) fora do canal de espera:`;
    for (const player of players) {
      const row = el('div', 'queue-grace-row');
      row.appendChild(el('strong', null, player.username || player.userId));
      row.appendChild(el('span', 'muted small', `protocolo #${String(player.protocol).padStart(4, '0')}`));
      if (player.position) row.appendChild(el('span', 'muted small', `${player.position}º na fila`));
      row.appendChild(el('span', 'countdown', `${player.remainingSeconds}s`));
      list.appendChild(row);
    }
  }

  async function loadQueue() {
    try {
      renderQueue(await api('/api/queue'));
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.message);
    }
  }

  async function saveQueueConfig() {
    const button = $('queue-save');
    const seconds = Number($('wait-grace-seconds').value);
    button.disabled = true;
    button.textContent = 'Salvando…';
    try {
      const data = await api('/api/queue', {
        method: 'PUT',
        body: JSON.stringify({
          waitGraceEnabled: $('wait-grace-enabled').checked,
          waitGraceSeconds: seconds,
        }),
      });
      renderQueue(data);
      toast(
        data.waitGrace.enabled
          ? `Fila atualizada: aguarda ${data.waitGrace.seconds}s para a reconexão.`
          : 'Fila atualizada: remoção imediata ao sair do canal de espera.',
      );
    } catch (error) {
      toast(error.message);
      await loadQueue();
    } finally {
      button.disabled = false;
      button.textContent = 'Salvar';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Horário de funcionamento                                            */
  /* ------------------------------------------------------------------ */

  /** Cria a linha de um turno: [início] às [fim] [remover]. */
  function shiftRow(window = { open: '12:00', close: '02:00' }) {
    const row = el('div', 'shift-row');
    const open = document.createElement('input');
    open.type = 'time';
    open.value = window.open || '12:00';
    open.className = 'shift-open';
    open.setAttribute('aria-label', 'Abertura');

    const close = document.createElement('input');
    close.type = 'time';
    close.value = window.close || '02:00';
    close.className = 'shift-close';
    close.setAttribute('aria-label', 'Fechamento');

    const remove = el('button', 'link', 'remover');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      const day = row.closest('.schedule-day');
      row.remove();
      updateDayState(day);
    });

    row.append(open, el('span', 'muted small', 'às'), close, remove);
    return row;
  }

  function updateDayState(day) {
    if (!day) return;
    const rows = day.querySelectorAll('.shift-row');
    const toggle = day.querySelector('input[type="checkbox"]');
    const box = day.querySelector('.shift-list');
    const hasRows = rows.length > 0;
    toggle.checked = hasRows;
    box.hidden = !hasRows;
    const add = day.querySelector('.shift-add');
    if (add) add.hidden = !hasRows;
  }

  function buildDay(day) {
    const wrapper = el('div', 'schedule-day');
    wrapper.dataset.key = day.key;

    const head = el('div', 'schedule-day-head');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = day.windows.length > 0;
    toggle.setAttribute('aria-label', `Abrir em ${day.label}`);
    const name = el('span', 'schedule-day-name', day.label);
    const add = el('button', 'link shift-add', '+ turno');
    add.type = 'button';
    add.addEventListener('click', () => {
      const list = wrapper.querySelector('.shift-list');
      list.appendChild(shiftRow());
      updateDayState(wrapper);
    });
    head.append(toggle, name, add);

    const list = el('div', 'shift-list');
    for (const window of day.windows.length ? day.windows : []) list.appendChild(shiftRow(window));

    toggle.addEventListener('change', () => {
      if (toggle.checked && list.children.length === 0) list.appendChild(shiftRow());
      if (!toggle.checked) {
        list.innerHTML = '';
      }
      updateDayState(wrapper);
    });

    wrapper.append(head, list);
    updateDayState(wrapper);
    return wrapper;
  }

  /**
   * Resumo do estado da central.
   * Destaca o caso "aberta pelo horário, fechada manualmente" — o pedido do
   * painel é justamente poder fechar mesmo dentro do horário.
   */
  function centralSummary(data) {
    const status = data.status || {};
    const manual = data.centralManual || 'auto';
    const scheduled = status.scheduledOpen;

    if (manual === 'closed') {
      return {
        badge: 'FECHADA',
        tone: 'closed',
        reason: scheduled
          ? 'Fechada manualmente, mesmo dentro do horário de funcionamento.'
          : 'Fechada manualmente (também fora do horário).',
        manual,
      };
    }
    if (manual === 'open') {
      return {
        badge: 'ABERTA',
        tone: 'open',
        reason: scheduled
          ? 'Aberta manualmente (o horário também permite).'
          : 'Aberta manualmente, fora do horário de funcionamento.',
        manual,
      };
    }
    return {
      badge: status.open ? 'ABERTA' : 'FECHADA',
      tone: status.open ? 'open' : 'closed',
      reason: status.open
        ? 'Aberta pelo horário de funcionamento.'
        : 'Fechada pelo horário de funcionamento.',
      manual,
    };
  }

  function renderCentralState(data) {
    const summary = centralSummary(data);
    const badge = $('central-badge');
    badge.textContent = summary.badge;
    badge.dataset.tone = summary.tone;
    $('central-reason').textContent = summary.reason;

    $('central-close').disabled = summary.manual === 'closed';
    $('central-open').disabled = summary.manual === 'open';
    $('central-auto').disabled = summary.manual === 'auto';

    const status = data.status || {};
    $('schedule-status').textContent = `hoje: ${status.today || '—'}`;
    $('schedule-today').textContent = status.nextOpen
      ? `Próxima abertura: ${status.nextOpen}.`
      : '';
  }

  function renderSchedule(data) {
    const container = $('schedule-days');
    container.innerHTML = '';
    for (const day of data.days) container.appendChild(buildDay(day));
    renderCentralState(data);
  }

  async function loadSchedule() {
    try {
      const data = await api('/api/schedule');
      renderSchedule(data);
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.message);
    }
  }

  /** Monta o JSON { sun: [{open, close}], ... } a partir da tela. */
  function collectSchedule() {
    const schedule = {};
    for (const day of $('schedule-days').querySelectorAll('.schedule-day')) {
      const windows = [];
      for (const row of day.querySelectorAll('.shift-row')) {
        const open = row.querySelector('.shift-open').value;
        const close = row.querySelector('.shift-close').value;
        if (open && close) windows.push({ open, close });
      }
      schedule[day.dataset.key] = windows;
    }
    return schedule;
  }

  async function saveScheduleConfig() {
    const button = $('schedule-save');
    button.disabled = true;
    button.textContent = 'Salvando…';
    try {
      const data = await api('/api/schedule', {
        method: 'PUT',
        body: JSON.stringify({ schedule: collectSchedule() }),
      });
      renderSchedule(data);
      toast('Horário salvo.');
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Salvar horário';
    }
  }

  /** Abre, fecha ou devolve a central ao horário — vale na hora. */
  async function setCentralState(state) {
    const buttons = ['central-close', 'central-open', 'central-auto'].map((id) => $(id));
    for (const button of buttons) button.disabled = true;

    try {
      const data = await api('/api/central', {
        method: 'PUT',
        body: JSON.stringify({ state }),
      });
      renderCentralState(data);
      const notes = {
        closed: data.queueCleared
          ? 'Central fechada. A fila foi encerrada.'
          : 'Central fechada. A fila existente foi mantida.',
        open: 'Central aberta.',
        auto: 'Central de volta ao horário de funcionamento.',
      };
      toast(notes[state] ?? 'Estado atualizado.');
    } catch (error) {
      toast(error.message);
      await loadSchedule();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Avaliações                                                          */
  /* ------------------------------------------------------------------ */

  const RATING_CLASS = {
    MUITO_BOM: 'rating-4',
    BOM: 'rating-3',
    REGULAR: 'rating-2',
    RUIM: 'rating-1',
  };

  /** Preenche o filtro de atendente sem perder a seleção atual. */
  function renderStaffOptions(data) {
    const select = $('eval-staff');
    const current = select.value || data.staffFilter || '';
    select.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'Todos';
    select.appendChild(all);
    for (const option of data.staffOptions || []) {
      const node = document.createElement('option');
      node.value = option.userId;
      node.textContent = option.name || option.userId;
      select.appendChild(node);
    }
    select.value = current;
    if (select.value !== current) select.value = '';
  }

  async function saveAlertThreshold() {
    const button = $('eval-alert-save');
    const raw = Number(String($('eval-alert').value).replace(',', '.'));
    if (!Number.isFinite(raw) || raw < 0 || raw > 4) {
      toast('Informe um valor entre 0 e 4 (0 desliga o aviso).');
      return;
    }
    button.disabled = true;
    button.textContent = 'Salvando…';
    try {
      await api('/api/evaluations/alert', {
        method: 'PUT',
        body: JSON.stringify({ minAverage: raw }),
      });
      toast(raw > 0 ? `Aviso ativado para médias abaixo de ${raw.toFixed(2)}/4.` : 'Aviso de média desligado.');
      await loadEvaluations();
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Salvar alerta';
    }
  }

  /** CSV das avaliações do período (respeita o filtro de atendente). */
  function exportEvaluationsCsv() {
    const data = state.evaluations;
    if (!data) {
      toast('Ainda não há avaliações carregadas.');
      return;
    }
    const rows = [['data', 'protocolo', 'jogador_id', 'jogador', 'atendente_id', 'atendente', 'nota', 'pontos', 'duracao_min']];
    for (const entry of data.entries) {
      rows.push([
        entry.dateLabel,
        entry.protocol,
        entry.userId,
        entry.userName || '',
        entry.staffId || '',
        entry.staffName || '',
        entry.ratingLabel,
        entry.score ?? '',
        Math.round((entry.durationSeconds || 0) / 60),
      ]);
    }
    rows.push([]);
    rows.push(['resumo', 'media', data.average === null || data.average === undefined ? '' : data.average.toFixed(2)]);
    rows.push(['resumo', 'total', data.total]);
    rows.push(['resumo', 'positivas_%', data.positiveRate ?? '']);
    const csv = rows.map((line) => line.join(';')).join('\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `avaliacoes_${data.staffFilter || 'todos'}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function renderEvaluations(data) {
    const { total, average, positiveRate, byRating } = data;

    $('eval-average').textContent = average === null ? '—' : `${average.toFixed(2)}/4`;
    $('eval-total').textContent = String(total ?? 0);
    $('eval-positive').textContent = positiveRate === null ? '—' : `${positiveRate}%`;

    const ranking = Object.entries(byRating || {})
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);
    $('eval-top').textContent = ranking.length ? `${ratingLabel(ranking[0][0])} (${ranking[0][1]})` : '—';

    // Distribuição em barras (sem emoji, paleta VANTUS).
    const bars = $('eval-bars');
    bars.innerHTML = '';
    for (const key of ['MUITO_BOM', 'BOM', 'REGULAR', 'RUIM']) {
      const count = byRating?.[key] ?? 0;
      const share = total ? Math.round((count / total) * 100) : 0;
      const line = el('div', 'eval-bar');
      line.appendChild(el('span', 'eval-bar-label', ratingLabel(key)));
      const track = el('span', 'eval-bar-track');
      const fill = el('span', `eval-bar-fill ${RATING_CLASS[key]}`);
      fill.style.width = `${share}%`;
      track.appendChild(fill);
      line.appendChild(track);
      line.appendChild(el('span', 'eval-bar-value', `${count} · ${share}%`));
      bars.appendChild(line);
    }

    const body = $('eval-body');
    body.innerHTML = '';
    if (!data.entries.length) {
      const row = el('tr');
      const cell = el('td', 'empty', 'Nenhuma avaliação no período.');
      cell.colSpan = 5;
      row.appendChild(cell);
      body.appendChild(row);
    } else {
      for (const entry of data.entries) {
        const tr = el('tr');
        tr.appendChild(el('td', null, entry.dateLabel));
        tr.appendChild(el('td', null, entry.userName || entry.userId));
        tr.appendChild(el('td', null, entry.staffName || entry.staffId || '—'));
        const rating = el('td');
        rating.appendChild(el('span', `rating ${RATING_CLASS[entry.rating] || ''}`, entry.ratingLabel));
        tr.appendChild(rating);
        tr.appendChild(el('td', 'num', entry.protocolLabel));
        body.appendChild(tr);
      }
    }

    const rankBox = $('eval-ranking');
    rankBox.innerHTML = '';
    if (!data.byStaff.length) {
      rankBox.appendChild(el('p', 'muted small', 'Sem avaliações por atendente no período.'));
    } else {
      for (const item of data.byStaff.slice(0, 10)) {
        const line = el('div', 'eval-rank-row');
        line.appendChild(el('span', null, item.staffName || item.staffId));
        line.appendChild(el('strong', null, `${item.average?.toFixed(2) ?? '—'}/4`));
        line.appendChild(el('span', 'muted small', `${item.total} avaliação(ões)`));
        rankBox.appendChild(line);
      }
    }
  }

  function ratingLabel(key) {
    return (
      { MUITO_BOM: 'Muito bom', BOM: 'Bom', REGULAR: 'Regular', RUIM: 'Ruim' }[key] || key
    );
  }

  async function loadEvaluations() {
    try {
      const params = new URLSearchParams(periodQuery());
      const staffId = $('eval-staff') ? $('eval-staff').value : '';
      if (staffId) params.set('staffId', staffId);
      const query = params.toString();
      const data = await api(`/api/evaluations${query ? `?${query}` : ''}`);
      state.evaluations = data;
      renderStaffOptions(data);
      renderEvaluations(data);
      $('eval-staff').value = data.staffFilter || '';
      $('evaluation-channel').value = data.channelId || '';
      $('eval-alert').value = data.alertMinAverage ? String(data.alertMinAverage) : '0';
      $('eval-filter-note').textContent = staffId
        ? 'Mostrando só as avaliações deste atendente (o ranking continua completo).'
        : '';
      $('evaluation-channel-status').textContent = data.channelId
        ? `Publicando no canal ${data.channelId}.`
        : 'Nenhum canal configurado — as avaliações ficam só no painel e no log administrativo.';
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.message);
    }
  }

  async function saveEvaluationChannel() {
    const button = $('evaluation-channel-save');
    const value = $('evaluation-channel').value.trim();
    button.disabled = true;
    button.textContent = 'Salvando…';
    try {
      const data = await api('/api/evaluations/channel', {
        method: 'PUT',
        body: JSON.stringify({ channelId: value || null }),
      });
      $('evaluation-channel').value = data.channelId || '';
      toast(data.channelId ? 'Canal de avaliações salvo.' : 'Canal de avaliações removido.');
      await loadEvaluations();
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Salvar canal';
    }
  }

  async function refresh({ silent = false } = {}) {
    try {
      const query = periodQuery();
      const overview = await api(`/api/overview${query ? `?${query}` : ''}`);
      state.staff = overview.staff;
      state.period = overview.period;
      state.weekParity = overview.weekParity || null;
      if (state.weekParity) {
        $('weekend-note-panel').textContent =
          `Dias úteis têm horário fixo; o fim de semana desta semana é do grupo ${state.weekParity}.`;
      }
      $('guild').textContent = overview.guildId ? `Servidor ${overview.guildId}` : '';
      renderStats(overview);
      renderStaff(overview);
      renderScheduleList(overview.staff);
      await loadEvaluations();
      if (!silent) toast('Dados atualizados.');
    } catch (error) {
      if (error.message !== 'unauthorized' && !silent) toast(error.message);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Modal de escala                                                     */
  /* ------------------------------------------------------------------ */

  /** Preenche o modal com a escala atual do staff (dias úteis + fim de semana). */
  function openSchedule(row) {
    state.editing = row;
    $('modal-title').textContent = `Escala • ${row.staffName || row.userId}`;
    $('staff-name').value = row.staffName || '';
    $('modal-error').hidden = true;

    const summary = scheduleSummary(row);
    const weekdayShift = (row.shifts || []).find(
      (shift) => Number(shift.weekday) >= 1 && Number(shift.weekday) <= 5,
    );
    const weekendShift = (row.shifts || []).find(
      (shift) => Number(shift.weekday) === 0 || Number(shift.weekday) === 6,
    );

    $('weekday-enabled').checked = Boolean(summary.weekdays);
    $('weekday-start').value = weekdayShift?.start || '12:00';
    $('weekday-end').value = weekdayShift?.end || '18:00';

    $('weekend-enabled').checked = Boolean(summary.weekends);
    $('weekend-start').value = weekendShift?.start || '12:00';
    $('weekend-end').value = weekendShift?.end || '02:00';
    $('weekend-group').value = summary.weekendGroup || 'A';

    updateWeekendNote();
    $('modal').showModal();
  }

  function updateWeekendNote() {
    const enabled = $('weekend-enabled').checked;
    const group = $('weekend-group').value;
    const current = state.weekParity;
    const parts = [];
    if (!enabled) {
      parts.push('Sem fim de semana nesta escala.');
    } else if (group === 'all') {
      parts.push('Trabalha em todos os fins de semana.');
    } else {
      parts.push(`Grupos A e B se revezam: ${group === 'A' ? 'A' : 'B'} trabalha, ${group === 'A' ? 'B' : 'A'} folga.`);
      if (current) {
        parts.push(`Este fim de semana é do grupo ${current}${current === group ? ' (trabalha)' : ' (folga)'}.`);
      }
    }
    $('weekend-note').textContent = parts.join(' ');
  }

  async function saveSchedule(event) {
    event.preventDefault();
    const row = state.editing;
    if (!row) return;

    const shifts = [];
    if ($('weekday-enabled').checked) {
      // Segunda a sexta com o mesmo horário — sem cadastrar dia por dia.
      for (let weekday = 1; weekday <= 5; weekday += 1) {
        shifts.push({ weekday, start: $('weekday-start').value, end: $('weekday-end').value });
      }
    }
    if ($('weekend-enabled').checked) {
      const group = $('weekend-group').value;
      const parity = group === 'all' ? null : group;
      for (const weekday of [6, 0]) {
        shifts.push({ weekday, start: $('weekend-start').value, end: $('weekend-end').value, parity });
      }
    }

    try {
      await api(`/api/staff/${row.userId}/shifts`, {
        method: 'PUT',
        body: JSON.stringify({ staffName: $('staff-name').value.trim() || null, shifts }),
      });
      $('modal').close();
      toast('Escala salva.');
      await refresh({ silent: true });
    } catch (error) {
      const node = $('modal-error');
      node.textContent = error.message;
      node.hidden = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Modal de nome                                                       */
  /* ------------------------------------------------------------------ */

  function openName(row) {
    state.renaming = row;
    $('name-title').textContent = `Nome do staff • ${row.userId}`;
    $('name-input').value = row.staffName || '';
    $('name-error').hidden = true;
    $('name-modal').showModal();
    try {
      $('name-input').focus();
      $('name-input').select();
    } catch {
      /* foco opcional */
    }
  }

  async function submitName(staffName) {
    const row = state.renaming;
    if (!row) return;
    try {
      const data = await api(`/api/staff/${row.userId}/name`, {
        method: 'PUT',
        body: JSON.stringify({ staffName }),
      });
      $('name-modal').close();
      toast(data.staffName ? 'Nome salvo.' : 'Nome removido — usando o nome do Discord.');
      await refresh({ silent: true });
    } catch (error) {
      const node = $('name-error');
      node.textContent = error.message;
      node.hidden = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Modal: tirar de serviço                                             */
  /* ------------------------------------------------------------------ */

  function openOffService(row) {
    state.offService = row;
    $('off-title').textContent = `Tirar de serviço • ${row.staffName || row.userId}`;
    const parts = [];
    if (row.session) parts.push(`Sessão aberta desde ${row.session.entry}.`);
    parts.push(`Status atual: ${row.statusLabel}.`);
    parts.push('A sessão será encerrada agora e as horas ficam registradas no banco.');
    $('off-text').textContent = parts.join(' ');
    $('off-voice').checked = true;
    $('off-error').hidden = true;
    $('off-modal').showModal();
  }

  async function submitOffService(event) {
    event.preventDefault();
    const row = state.offService;
    if (!row) return;
    const button = $('off-confirm');
    button.disabled = true;
    button.textContent = 'Encerrando…';
    try {
      const data = await api(`/api/staff/${row.userId}/off-service`, {
        method: 'POST',
        body: JSON.stringify({ disconnectVoice: $('off-voice').checked }),
      });
      $('off-modal').close();
      const ended = data.endedSession ? ` Sessão de ${data.endedSession.label} encerrada.` : '';
      toast(`${row.staffName || row.userId} fora de serviço.${ended}`);
      await refresh({ silent: true });
    } catch (error) {
      const node = $('off-error');
      node.textContent = error.message;
      node.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Tirar de serviço';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Modal: bloquear / desbloquear staff                                 */
  /* ------------------------------------------------------------------ */

  function openBlock(row) {
    state.blocking = row;
    $('block-title').textContent = `Bloquear • ${row.staffName || row.userId}`;
    const parts = [`Status atual: ${row.statusLabel}.`];
    if (row.session) parts.push(`Sessão aberta desde ${row.session.entry} — será encerrada agora.`);
    else parts.push('O staff sai de serviço agora.');
    $('block-text').textContent = parts.join(' ');
    $('block-reason').value = '';
    $('block-error').hidden = true;
    $('block-modal').showModal();
  }

  async function submitBlock(event) {
    event.preventDefault();
    const row = state.blocking;
    if (!row) return;
    const button = $('block-confirm');
    button.disabled = true;
    button.textContent = 'Bloqueando…';
    try {
      const data = await api(`/api/staff/${row.userId}/block`, {
        method: 'PUT',
        body: JSON.stringify({ blocked: true, reason: $('block-reason').value.trim() || null }),
      });
      $('block-modal').close();
      const ended = data.endedSession ? ` Sessão de ${data.endedSession.label} encerrada.` : '';
      toast(`${row.staffName || row.userId} bloqueado de entrar em serviço.${ended}`);
      await refresh({ silent: true });
    } catch (error) {
      const node = $('block-error');
      node.textContent = error.message;
      node.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Bloquear';
    }
  }

  async function toggleBlock(row, blocked) {
    try {
      await api(`/api/staff/${row.userId}/block`, {
        method: 'PUT',
        body: JSON.stringify({ blocked }),
      });
      toast(
        blocked
          ? `${row.staffName || row.userId} bloqueado.`
          : `${row.staffName || row.userId} liberado para entrar em serviço.`,
      );
      await refresh({ silent: true });
    } catch (error) {
      toast(error.message);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Modal: remover da equipe                                            */
  /* ------------------------------------------------------------------ */

  function openRemove(row) {
    state.removing = row;
    $('remove-title').textContent = `Remover • ${row.staffName || row.userId}`;
    const parts = ['Essa ação tira o staff do quadro da equipe.'];
    if (row.session) parts.push(`A sessão aberta desde ${row.session.entry} será encerrada.`);
    if (row.blocked) parts.push('O bloqueio também é removido.');
    $('remove-text').textContent = parts.join(' ');
    $('remove-error').hidden = true;
    $('remove-modal').showModal();
  }

  async function submitRemove(event) {
    event.preventDefault();
    const row = state.removing;
    if (!row) return;
    const button = $('remove-confirm');
    button.disabled = true;
    button.textContent = 'Removendo…';
    try {
      const data = await api(`/api/staff/${row.userId}`, { method: 'DELETE' });
      $('remove-modal').close();
      const ended = data.endedSession ? ` Sessão de ${data.endedSession.label} encerrada.` : '';
      toast(`${row.staffName || row.userId} removido da equipe.${ended}`);
      await refresh({ silent: true });
    } catch (error) {
      const node = $('remove-error');
      node.textContent = error.message;
      node.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Remover da equipe';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Modal de sessões                                                    */
  /* ------------------------------------------------------------------ */

  async function openSessions(row) {
    $('sessions-title').textContent = `Sessões • ${row.staffName || row.userId}`;
    const body = $('sessions-body');
    body.innerHTML = '<p class="muted small">Carregando…</p>';
    $('sessions-modal').showModal();

    try {
      const query = periodQuery();
      const data = await api(`/api/sessions?userId=${row.userId}${query ? `&${query}` : ''}`);
      body.innerHTML = '';
      if (!data.sessions.length) {
        body.appendChild(el('p', 'muted small', 'Nenhuma sessão no período.'));
        return;
      }
      for (const session of data.sessions) {
        const line = el('div', 'session-row');
        line.appendChild(el('span', 'day', `${session.day} • ${session.entry} → ${session.exit || 'em andamento'}`));
        line.appendChild(el('span', null, session.label));
        const badge = el('span', 'badge');
        if (session.open) {
          badge.classList.add('open');
          badge.textContent = 'EM SERVIÇO';
        } else if (session.lateMinutes > 0) {
          badge.classList.add('late');
          badge.textContent = `ATRASO ${session.lateMinutes} min`;
        } else {
          badge.textContent = 'NO HORÁRIO';
        }
        line.appendChild(badge);
        body.appendChild(line);
      }
    } catch (error) {
      body.innerHTML = '';
      body.appendChild(el('p', 'error', error.message));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Escala no canal (webhook)                                           */
  /* ------------------------------------------------------------------ */

  // Dias na ordem da semana (segunda → domingo), como no calendário da equipe.
  const DAY_OPTIONS = [
    { value: 1, label: 'Segunda-feira' },
    { value: 2, label: 'Terça-feira' },
    { value: 3, label: 'Quarta-feira' },
    { value: 4, label: 'Quinta-feira' },
    { value: 5, label: 'Sexta-feira' },
    { value: 6, label: 'Sábado' },
    { value: 0, label: 'Domingo' },
  ];

  function fillDayOptions() {
    const select = $('webhook-day');
    select.innerHTML = '';
    for (const option of DAY_OPTIONS) {
      const node = el('option', null, option.label);
      node.value = String(option.value);
      select.appendChild(node);
    }
  }

  function autoStatusText(config) {
    if (!config.auto) return 'Envio automático desligado.';
    const day = DAY_OPTIONS.find((option) => option.value === Number(config.day));
    const last = config.lastWeekLabel
      ? `Última semana publicada: ${config.lastWeekLabel}.`
      : 'Ainda não publicado automaticamente.';
    return `Envio automático toda ${day ? day.label.toLowerCase() : config.dayLabel} às ${config.time}. ${last}`;
  }

  function webhookStatus(message, state = '') {
    const node = $('webhook-status');
    node.className = state ? `status-line ${state}` : 'status-line';
    node.textContent = message;
  }

  function applyWebhookConfig(data) {
    $('webhook-url').value = data.url || '';
    $('webhook-auto').checked = Boolean(data.auto);
    $('webhook-day').value = String(Number.isInteger(Number(data.day)) ? Number(data.day) : 1);
    $('webhook-time').value = data.time || '09:00';
    if (!data.configured) {
      webhookStatus('Nenhum webhook salvo. Cole a URL do webhook do canal e clique em Salvar.');
      return;
    }
    webhookStatus(`Webhook salvo. ${autoStatusText(data)}`);
  }

  async function loadWebhook() {
    try {
      const data = await api('/api/schedule/webhook');
      applyWebhookConfig(data);
    } catch (error) {
      if (error.message !== 'unauthorized') webhookStatus(error.message, 'bad');
    }
  }

  async function saveWebhook() {
    const button = $('webhook-save');
    const url = $('webhook-url').value.trim();
    button.disabled = true;
    button.textContent = 'Salvando…';
    try {
      const data = await api('/api/schedule/webhook', {
        method: 'PUT',
        body: JSON.stringify({
          url,
          auto: $('webhook-auto').checked,
          day: Number($('webhook-day').value),
          time: $('webhook-time').value || '09:00',
        }),
      });
      applyWebhookConfig(data);
      webhookStatus(
        data.configured
          ? `Webhook salvo. ${autoStatusText(data)}`
          : 'Webhook removido: o painel não publica mais a escala.',
        'ok',
      );
      toast(data.configured ? 'Webhook salvo.' : 'Webhook removido.');
    } catch (error) {
      webhookStatus(error.message, 'bad');
    } finally {
      button.disabled = false;
      button.textContent = 'Salvar';
    }
  }

  async function sendSchedule() {
    const button = $('schedule-send');
    button.disabled = true;
    button.textContent = 'Enviando…';
    try {
      const data = await api('/api/schedule/send', { method: 'POST' });
      const staff = data.staffCount === 1 ? '1 staff' : `${data.staffCount} staff`;
      const shifts = data.shiftCount === 1 ? '1 turno' : `${data.shiftCount} turnos`;
      webhookStatus(`Escala de ${data.week.startLabel} a ${data.week.endLabel} enviada (${staff}, ${shifts}).`, 'ok');
      toast('Escala enviada no canal.');
    } catch (error) {
      webhookStatus(error.message, 'bad');
    } finally {
      button.disabled = false;
      button.textContent = 'Enviar escala agora';
    }
  }

  /* ------------------------------------------------------------------ */
  /* CSV                                                                 */
  /* ------------------------------------------------------------------ */

  async function exportCsv() {
    try {
      const query = periodQuery();
      const report = await api(`/api/report${query ? `?${query}` : ''}`);
      const rows = [['staff', 'id', 'horas', 'sessoes', 'entrada', 'saida', 'atrasos', 'minutos_atraso', 'saida_antecipada_min']];
      for (const item of report.staff) {
        rows.push([
          item.staffName || '',
          item.userId,
          (item.totalMinutes / 60).toFixed(2).replace('.', ','),
          item.sessions,
          item.entryLabel,
          item.exitLabel,
          item.lateCount,
          item.lateMinutes,
          item.earlyLeaveMinutes,
        ]);
      }
      const csv = rows.map((line) => line.join(';')).join('\n');
      const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `banco-de-horas_${report.period.from.replace(/\//g, '-')}_${report.period.to.replace(/\//g, '-')}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast(error.message);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Eventos                                                             */
  /* ------------------------------------------------------------------ */

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('login-error');
    const button = $('login-submit');
    error.hidden = true;
    if (button) {
      button.disabled = true;
      button.textContent = 'Entrando…';
    }
    try {
      const data = await api('/api/login', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({ password: $('password').value }),
      });
      // Guarda o token: em iframe/preview o cookie pode ser bloqueado pelo navegador.
      if (!data.token) {
        throw new Error('O servidor não devolveu a sessão. Verifique se o painel está atualizado.');
      }
      setToken(data.token);
      $('password').value = '';
      error.hidden = true;
      $('login-hint').hidden = true;
      showApp();
      setPeriod(6);
      await refresh({ silent: true });
      await loadWebhook();
      await loadEvaluations();
      await loadSchedule();
      await loadQueue();
      clearInterval(state.timer);
      state.timer = setInterval(() => refresh({ silent: true }), 30000);
    } catch (requestError) {
      error.textContent = requestError.message;
      error.hidden = false;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Entrar';
      }
    }
  });

  $('logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => null);
    setToken('');
    $('password').value = '';
    showLogin();
    try {
      $('password').focus();
    } catch {
      /* foco opcional */
    }
  });

  $('period-buttons').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    setPeriod(Number(chip.dataset.days));
    refresh({ silent: true });
  });

  $('apply').addEventListener('click', () => refresh());
  $('export').addEventListener('click', exportCsv);
  $('weekend-enabled').addEventListener('change', updateWeekendNote);
  $('weekend-group').addEventListener('change', updateWeekendNote);
  $('force-reload').addEventListener('click', () => {
    setToken('');
    // Recarrega ignorando o cache do navegador.
    window.location.reload();
  });
  $('cancel').addEventListener('click', () => $('modal').close());
  $('sessions-close').addEventListener('click', () => $('sessions-modal').close());
  $('schedule-form').addEventListener('submit', saveSchedule);

  $('name-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitName($('name-input').value.trim());
  });

  fillDayOptions();
  $('webhook-save').addEventListener('click', saveWebhook);
  $('evaluation-channel-save').addEventListener('click', saveEvaluationChannel);
  $('eval-alert-save').addEventListener('click', saveAlertThreshold);
  $('eval-export').addEventListener('click', exportEvaluationsCsv);
  $('schedule-save').addEventListener('click', saveScheduleConfig);
  $('queue-save').addEventListener('click', saveQueueConfig);
  $('wait-grace-enabled').addEventListener('change', () => {
    $('wait-grace-seconds').disabled = !$('wait-grace-enabled').checked;
  });
  $('central-close').addEventListener('click', () => setCentralState('closed'));
  $('central-open').addEventListener('click', () => setCentralState('open'));
  $('central-auto').addEventListener('click', () => setCentralState('auto'));
  $('eval-staff').addEventListener('change', () => loadEvaluations());
  $('schedule-send').addEventListener('click', sendSchedule);
  $('webhook-url').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveWebhook();
    }
  });
  $('name-cancel').addEventListener('click', () => $('name-modal').close());
  $('off-form').addEventListener('submit', submitOffService);
  $('off-cancel').addEventListener('click', () => $('off-modal').close());
  $('block-form').addEventListener('submit', submitBlock);
  $('block-cancel').addEventListener('click', () => $('block-modal').close());
  $('remove-form').addEventListener('submit', submitRemove);
  $('remove-cancel').addEventListener('click', () => $('remove-modal').close());
  $('name-discord').addEventListener('click', () => submitName(''));

  // Sessão existente? Abre direto no painel.
  (async () => {
    try {
      const overview = await api('/api/overview');
      showApp();
      setPeriod(6);
      state.staff = overview.staff;
      state.weekParity = overview.weekParity || null;
      renderStats(overview);
      renderStaff(overview);
      renderScheduleList(overview.staff);
      await loadWebhook();
      await loadEvaluations();
      await loadSchedule();
      await loadQueue();
      state.timer = setInterval(() => refresh({ silent: true }), 30000);
    } catch {
      showLogin();
    }
  })();
})();
