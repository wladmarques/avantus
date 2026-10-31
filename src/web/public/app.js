'use strict';

/**
 * Interface do painel web do banco de horas.
 * Consome a API do bot (mesma origem) — nenhuma dependência externa.
 */
(() => {
  const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

  const state = {
    staff: [],
    period: { from: '', to: '' },
    editing: null,
    timer: null,
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

  const getToken = () => {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  };

  const setToken = (token) => {
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* sessionStorage indisponível (modo restrito): segue só com cookie */
    }
  };

  async function api(path, options = {}) {
    const token = getToken();
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...options,
    });
    if (response.status === 401) {
      setToken('');
      showLogin('Sessão expirada. Entre novamente.');
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
    if (message) {
      const error = $('login-error');
      error.textContent = message;
      error.hidden = false;
    }
    clearInterval(state.timer);
  }

  function showApp() {
    $('login').hidden = true;
    $('app').hidden = false;
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

  function shiftTextForToday(row) {
    if (row.currentShift) return `${row.currentShift.start} às ${row.currentShift.end}`;
    const weekday = new Date().getDay();
    const day = (row.weekly || [])[weekday];
    if (day && day.shifts.length > 0) {
      return day.shifts.map((shift) => `${shift.start} às ${shift.end}`).join(' / ');
    }
    if (row.nextShift) return `próximo: ${row.nextShift.start} (${row.nextShift.dayKey.slice(8, 10)}/${row.nextShift.dayKey.slice(5, 7)})`;
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
      whoBox.appendChild(el('strong', null, row.staffName || `Usuário ${row.userId}`));
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
      const edit = el('button', 'btn tiny', 'Editar escala');
      edit.addEventListener('click', () => openSchedule(row));
      actions.appendChild(edit);

      for (const cell of [who, status, shift, entry, exit, hours, late, actions]) tr.appendChild(cell);
      body.appendChild(tr);
    }
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
      const card = el('div', 'schedule-card');
      const title = el('h3');
      title.appendChild(el('span', null, row.staffName || row.userId));
      const edit = el('button', 'btn tiny', 'Editar');
      edit.addEventListener('click', () => openSchedule(row));
      title.appendChild(edit);
      card.appendChild(title);

      const list = el('ul');
      for (const day of row.weekly) {
        if (!day.shifts.length) continue;
        const item = el('li');
        item.appendChild(el('span', null, day.label));
        item.appendChild(el('strong', null, day.shifts.map((shift) => `${shift.start}–${shift.end}`).join(' / ')));
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

  function shiftRow(shift = { weekday: 1, start: '12:00', end: '18:00' }) {
    const row = el('div', 'shift-row');

    const select = el('select');
    WEEKDAYS.forEach((label, index) => {
      const option = el('option', null, label);
      option.value = String(index);
      if (Number(shift.weekday) === index) option.selected = true;
      select.appendChild(option);
    });

    const start = el('input');
    start.type = 'time';
    start.value = shift.start || '12:00';

    const end = el('input');
    end.type = 'time';
    end.value = shift.end || '18:00';

    const remove = el('button', 'icon-btn', '×');
    remove.type = 'button';
    remove.title = 'Remover turno';
    remove.addEventListener('click', () => row.remove());

    row.append(select, start, end, remove);
    return row;
  }

  function openSchedule(row) {
    state.editing = row;
    $('modal-title').textContent = `Escala • ${row.staffName || row.userId}`;
    $('staff-name').value = row.staffName || '';
    $('modal-error').hidden = true;

    const rows = $('shift-rows');
    rows.innerHTML = '';
    for (const shift of row.shifts || []) rows.appendChild(shiftRow(shift));
    if (!rows.children.length) rows.appendChild(shiftRow());
    $('modal').showModal();
  }

  async function saveSchedule(event) {
    event.preventDefault();
    const row = state.editing;
    if (!row) return;

    const shifts = [];
    for (const item of $('shift-rows').children) {
      const [select, start, end] = item.querySelectorAll('select, input');
      shifts.push({ weekday: Number(select.value), start: start.value, end: end.value });
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
    error.hidden = true;
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ password: $('password').value }),
      });
      // Guarda o token: em iframe/preview o cookie pode ser bloqueado pelo navegador.
      if (data.token) setToken(data.token);
      $('password').value = '';
      showApp();
      setPeriod(6);
      await refresh({ silent: true });
      clearInterval(state.timer);
      state.timer = setInterval(() => refresh({ silent: true }), 30000);
    } catch (requestError) {
      error.textContent = requestError.message;
      error.hidden = false;
    }
  });

  $('logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => null);
    setToken('');
    showLogin();
  });

  $('period-buttons').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    setPeriod(Number(chip.dataset.days));
    refresh({ silent: true });
  });

  $('apply').addEventListener('click', () => refresh());
  $('export').addEventListener('click', exportCsv);
  $('add-shift').addEventListener('click', () => $('shift-rows').appendChild(shiftRow()));
  $('cancel').addEventListener('click', () => $('modal').close());
  $('sessions-close').addEventListener('click', () => $('sessions-modal').close());
  $('schedule-form').addEventListener('submit', saveSchedule);

  // Sessão existente? Abre direto no painel.
  (async () => {
    try {
      const overview = await api('/api/overview');
      showApp();
      setPeriod(6);
      state.staff = overview.staff;
      renderStats(overview);
      renderStaff(overview);
      renderScheduleList(overview.staff);
      state.timer = setInterval(() => refresh({ silent: true }), 30000);
    } catch {
      showLogin();
    }
  })();
})();
