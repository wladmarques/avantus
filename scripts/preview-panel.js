'use strict';

/**
 * Gera uma pré-visualização do painel público em HTML.
 *   npm run preview:panel  →  preview/panel.html
 *
 * O HTML usa exatamente o payload gerado em produção (mesma árvore de
 * componentes), então serve para aprovar o layout antes de publicar no Discord.
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildPublicPanelV2 } = require('../src/dashboard/panels/publicPanel');
const { DEFAULT_SCHEDULE } = require('../src/config/settings');

const root = path.join(__dirname, '..');
const outFile = path.join(root, 'preview', 'panel.html');

const fullState = {
  waiting: [{ position: 1 }],
  serving: [],
  hold: [],
  staffCounts: { DISPONIVEL: 1, EM_ATENDIMENTO: 0 },
};

const scenarios = {
  aberta: {
    schedule: { open: true, nextOpen: null, schedule: DEFAULT_SCHEDULE },
    state: fullState,
    estimateWaitSeconds: 600,
  },
  movimentada: {
    schedule: { open: true, nextOpen: null, schedule: DEFAULT_SCHEDULE },
    state: {
      waiting: [1, 2, 3, 4],
      serving: [1, 2],
      hold: [],
      staffCounts: { DISPONIVEL: 3, EM_ATENDIMENTO: 2 },
    },
    estimateWaitSeconds: 780,
  },
  sem_staff: {
    schedule: { open: true, nextOpen: null, schedule: DEFAULT_SCHEDULE },
    state: { waiting: [1], serving: [], hold: [], staffCounts: { DISPONIVEL: 0, EM_ATENDIMENTO: 0 } },
    estimateWaitSeconds: 900,
  },
  fechada: {
    schedule: { open: false, nextOpen: 'amanhã às 12:00', schedule: DEFAULT_SCHEDULE },
    state: { waiting: [], serving: [], hold: [], staffCounts: { DISPONIVEL: 0, EM_ATENDIMENTO: 0 } },
    estimateWaitSeconds: 0,
  },
};

const baseSettings = {
  message_panel_title: '🎧 ATENDIMENTO | VANTUS',
  message_panel_description: 'Use a ação abaixo para entrar na fila e aguarde as atualizações.',
  wait_channel_id: '000000000000000000',
};

const payloads = Object.fromEntries(
  Object.entries(scenarios).map(([key, scenario]) => [
    key,
    buildPublicPanelV2({
      settings: { ...baseSettings, estimateWaitSeconds: scenario.estimateWaitSeconds },
      state: scenario.state,
      schedule: scenario.schedule,
      iconUrl: 'server-icon',
      now: new Date(),
    }).payload,
  ]),
);

const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VANTUS • Pré-visualização do painel</title>
<style>
  :root {
    --bg: #1e1f22;
    --panel: #2b2d31;
    --card: #232428;
    --text: #f2f3f5;
    --subtle: #949ba4;
    --green: #248046;
    --brand: #5865f2;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
    padding: 24px 16px 56px;
  }
  .wrap { max-width: 700px; margin: 0 auto; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .toolbar button {
    background: #313338; color: var(--text); border: 1px solid #3f4147;
    border-radius: 8px; padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .toolbar button.active { background: #404249; border-color: #5c5f66; }
  .message { background: var(--panel); border-radius: 10px; padding: 14px 16px; display: flex; gap: 14px; }
  .avatar {
    width: 40px; height: 40px; border-radius: 50%; flex: 0 0 40px;
    background: linear-gradient(135deg, #ff7a18, #ff2d95 55%, #8b5cf6);
    display: grid; place-items: center; font-size: 18px;
  }
  .body { flex: 1; min-width: 0; }
  .author { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .bot-tag { background: var(--brand); font-size: 10px; font-weight: 700; border-radius: 3px; padding: 1px 4px; }
  .timestamp { color: var(--subtle); font-size: 12px; font-weight: 400; margin-left: 2px; }
  .container {
    margin-top: 8px; background: var(--card); border-radius: 10px;
    border-left: 4px solid var(--accent, #5865f2); padding: 14px 16px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .sep { height: 1px; background: #3b3d44; }
  .sep.small { opacity: .6; }
  .section { display: flex; gap: 14px; align-items: center; justify-content: space-between; }
  .section .content { flex: 1; min-width: 0; }
  .thumb { width: 68px; height: 68px; border-radius: 8px; overflow: hidden; flex: 0 0 68px; background: #313338; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .t { font-size: 14.5px; line-height: 1.45; white-space: pre-wrap; }
  .h1 { font-size: 23px; font-weight: 700; margin: 0; }
  .h2 { font-size: 26px; font-weight: 700; margin: 1px 0 2px; }
  .label { font-size: 12.5px; font-weight: 700; letter-spacing: .02em; }
  .sub { color: var(--subtle); font-size: 13px; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; }
  .chip {
    background: #2b2d31; border-radius: 6px; padding: 3px 8px;
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 13px; color: #dbdee1;
  }
  .chip-value { font-weight: 700; font-size: 15px; margin-left: 4px; }
  .stat { display: flex; flex-direction: column; gap: 0; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn {
    border: none; border-radius: 4px; padding: 9px 16px; font-size: 14px; font-weight: 600;
    color: #fff; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  }
  .btn.success { background: var(--green); }
  .btn.primary { background: var(--brand); }
  .btn.secondary { background: #4e5058; }
  .btn.danger { background: #da373c; }
  .mention { background: rgba(88, 101, 242, .3); color: #c9cdfb; border-radius: 3px; padding: 0 2px; font-weight: 500; }
  .note { margin-top: 22px; color: var(--subtle); font-size: 12.5px; line-height: 1.55; border-top: 1px solid #2f3136; padding-top: 14px; }
  code.key { background: #1e1f22; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="toolbar">
    <button data-scenario="aberta" class="active">Fila aberta</button>
    <button data-scenario="movimentada">Movimento alto</button>
    <button data-scenario="sem_staff">Sem staff</button>
    <button data-scenario="fechada">Fechada</button>
  </div>
  <div class="message">
    <div class="avatar">🎧</div>
    <div class="body">
      <div class="author">VANTUS ATENDIMENTO <span class="bot-tag">APP</span>
        <span class="timestamp" id="clock"></span>
      </div>
      <div id="root"></div>
    </div>
  </div>
  <div class="note">
    Pré-visualização do painel público em <strong>Components V2</strong> (<code class="key">panel_style=modern</code>):
    um único card, indicadores em linha e botão principal à direita do texto.<br>
    Para o layout em embed: <code class="key">/config definir chave:panel_style valor:classic</code>.
  </div>
</div>
<script>
const PAYLOADS = ${JSON.stringify(payloads)};

const ACCENTS = {
  16742936: '#ff7a18', 9144534: '#8b5cf6', 16723349: '#ff2d95',
  3719160: '#38bdf8', 2288663: '#22c55e', 15680580: '#ef4444', 7038819: '#6b7280',
};

function colorOf(value) {
  if (value === undefined || value === null) return '#5865f2';
  if (typeof value === 'number') return ACCENTS[value] || '#' + value.toString(16).padStart(6, '0');
  return value;
}

function esc(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function inline(raw) {
  let out = esc(raw);
  out = out.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  out = out.replace(/\\u0060([^\\u0060]+)\\u0060/g, '<span class="chip">$1</span>');
  out = out.replace(/&lt;#(\\d+)&gt;/g, '<span class="mention">#aguardando-atendimento</span>');
  out = out.replace(/<#(\\d+)>/g, '<span class="mention">#aguardando-atendimento</span>');
  return out;
}

/** Renderiza "**LABEL**", "## VALOR" e "-# subtexto" como o bloco de status. */
function renderText(content) {
  const lines = String(content).split('\\n');
  let html = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { html += '<div style="height:6px"></div>'; continue; }
    if (trimmed.startsWith('## ')) html += '<div class="h2">' + inline(trimmed.slice(3)) + '</div>';
    else if (trimmed.startsWith('-# ')) html += '<div class="sub">' + inline(trimmed.slice(3)) + '</div>';
    else if (/^\\*\\*[^*]+\\*\\*$/.test(trimmed)) html += '<div class="label">' + inline(trimmed) + '</div>';
    else html += '<div class="t">' + inline(trimmed) + '</div>';
  }
  return '<div class="stat">' + html + '</div>';
}

function renderButton(component) {
  const style = ['secondary', 'primary', 'success', 'danger'][(component.style ?? 2) - 1] || 'secondary';
  const emoji = component.emoji?.name ? component.emoji.name + ' ' : '';
  return '<button class="btn ' + style + '">' + emoji + esc(component.label || '') + '</button>';
}

function render(component) {
  switch (component.type) {
    case 17:
      return '<div class="container" style="--accent:' + colorOf(component.accent_color) + '">' +
        (component.components || []).map(render).join('') + '</div>';
    case 10:
      return renderText(component.content);
    case 14:
      return '<div class="sep' + (component.spacing === 2 ? '' : ' small') + '"></div>';
    case 9: {
      const content = '<div class="content">' + (component.components || []).map(render).join('') + '</div>';
      const accessory = component.accessory;
      let extra = '';
      if (accessory?.type === 11) {
        const url = accessory.media?.url;
        extra = url && url !== 'server-icon'
          ? '<div class="thumb"><img src="' + esc(url) + '" alt=""></div>'
          : '<div class="thumb" style="display:grid;place-items:center;font-size:26px">🎧</div>';
      } else if (accessory?.type === 2) {
        extra = renderButton(accessory);
      }
      return '<div class="section">' + content + extra + '</div>';
    }
    case 1:
      return '<div class="row">' + (component.components || []).map(render).join('') + '</div>';
    case 2:
      return renderButton(component);
    default:
      return '';
  }
}

function renderScenario(key) {
  const payload = PAYLOADS[key];
  document.getElementById('root').innerHTML = (payload.components || []).map(render).join('');
  document.querySelectorAll('.toolbar button').forEach((button) => {
    button.classList.toggle('active', button.dataset.scenario === key);
  });
}

document.querySelectorAll('.toolbar button').forEach((button) => {
  button.addEventListener('click', () => renderScenario(button.dataset.scenario));
});

const now = new Date();
document.getElementById('clock').textContent = 'hoje às ' +
  String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

renderScenario('aberta');
</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`✔ Pré-visualização gerada: ${path.relative(process.cwd(), outFile)}`);
