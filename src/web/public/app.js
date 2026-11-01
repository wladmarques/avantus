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
      status.appendChild(statusBox);

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
  $('schedule-send').addEventListener('click', sendSchedule);
  $('webhook-url').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveWebhook();
    }
  });
  $('name-cancel').addEventListener('click', () => $('name-modal').close());
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
      state.timer = setInterval(() => refresh({ silent: true }), 30000);
    } catch {
      showLogin();
    }
  })();
})();
