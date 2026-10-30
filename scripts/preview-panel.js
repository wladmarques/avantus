'use strict';

/**
 * Gera uma pré-visualização do painel público em HTML.
 *   npm run preview:panel  →  preview/panel.html
 * O HTML usa exatamente o payload gerado em produção (mesma estrutura de
 * componentes), então serve para aprovar o layout antes de publicar no Discord.
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildPublicPanelV2 } = require('../src/dashboard/panels/publicPanel');
const { DEFAULT_SCHEDULE } = require('../src/config/settings');

const root = path.join(__dirname, '..');
const outFile = path.join(root, 'preview', 'panel.html');

const demoState = {
  waiting: [{ position: 1 }, { position: 2 }, { position: 3 }],
  serving: [{ id: 1 }, { id: 2 }],
  hold: [],
  staffCounts: { DISPONIVEL: 3, EM_ATENDIMENTO: 2 },
  avgWaitSeconds: 420,
};

const scenarios = {
  aberta: {
    label: 'Central aberta',
    schedule: { open: true, nextOpen: null, schedule: DEFAULT_SCHEDULE },
    state: demoState,
  },
  fechada: {
    label: 'Central fechada',
    schedule: { open: false, nextOpen: 'amanhã às 12:00', schedule: DEFAULT_SCHEDULE },
    state: { ...demoState, waiting: [], serving: [], staffCounts: { DISPONIVEL: 0, EM_ATENDIMENTO: 0 } },
  },
};

const settings = {
  message_panel_title: '🎧 ATENDIMENTO | VANTUS',
  message_panel_description:
    'Precisa de ajuda? Entre na fila de atendimento e aguarde a disponibilidade de um membro da nossa equipe.\n\nNosso sistema organizará automaticamente os atendimentos por ordem de chegada.',
  estimateWaitSeconds: 480,
  wait_channel_id: '000000000000000000',
};

const payloads = Object.fromEntries(
  Object.entries(scenarios).map(([key, scenario]) => [
    key,
    buildPublicPanelV2({
      settings,
      state: scenario.state,
      schedule: scenario.schedule,
      iconUrl: null,
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
    --card-alt: #1e1f22;
    --text: #f2f3f5;
    --muted: #b5bac1;
    --subtle: #949ba4;
    --brand: #5865f2;
    --green: #248046;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
    padding: 28px 16px 64px;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 18px; align-items: center; flex-wrap: wrap; }
  .toolbar span { color: var(--subtle); font-size: 13px; }
  .toolbar button {
    background: #313338; color: var(--text); border: 1px solid #3f4147;
    border-radius: 8px; padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .toolbar button.active { background: #404249; border-color: #5c5f66; }
  .message {
    background: var(--panel); border-radius: 10px; padding: 16px;
    display: flex; gap: 14px;
  }
  .avatar {
    width: 40px; height: 40px; border-radius: 50%;
    background: linear-gradient(135deg, #ff7a18, #ff2d95 55%, #8b5cf6);
    flex: 0 0 40px; display: grid; place-items: center; font-size: 19px;
  }
  .body { flex: 1; min-width: 0; }
  .author { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .bot-tag {
    background: #5865f2; color: #fff; font-size: 10px; font-weight: 700;
    border-radius: 3px; padding: 1px 4px; letter-spacing: .02em;
  }
  .timestamp { color: var(--subtle); font-size: 12px; font-weight: 400; }
  .components { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
  .card {
    background: var(--card); border-radius: 8px; border-left: 4px solid var(--accent, #5865f2);
    padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
  }
  .card.tight { padding: 10px 14px; }
  .text { font-size: 14.5px; line-height: 1.42; white-space: pre-wrap; }
  .text h1 { font-size: 22px; margin: 0; font-weight: 700; }
  .text h2 { font-size: 19px; margin: 2px 0; font-weight: 700; }
  .text h3 { font-size: 16px; margin: 2px 0; font-weight: 700; }
  .subtext { color: var(--subtle); font-size: 12.5px; }
  .mention {
    background: rgba(88, 101, 242, .3); color: #c9cdfb;
    border-radius: 3px; padding: 0 2px; font-weight: 500;
  }
  .stat-label { font-size: 12.5px; font-weight: 700; letter-spacing: .01em; }
  .stat-value { font-size: 26px; font-weight: 700; line-height: 1.1; }
  .sep { height: 1px; background: #3f4147; margin: 2px 0; }
  .section { display: flex; gap: 12px; align-items: flex-start; }
  .section .text { flex: 1; }
  .thumb { width: 64px; height: 64px; border-radius: 8px; background: #313338; display: grid; place-items: center; font-size: 26px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
  .btn {
    border: none; border-radius: 4px; padding: 9px 16px; font-size: 14px; font-weight: 600;
    color: #fff; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  }
  .btn.success { background: var(--green); }
  .btn.primary { background: var(--brand); }
  .btn.secondary { background: #4e5058; }
  .btn.danger { background: #da373c; }
  .note {
    margin-top: 22px; color: var(--subtle); font-size: 12.5px; line-height: 1.5;
    border-top: 1px solid #2f3136; padding-top: 14px;
  }
  code { background: #1e1f22; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="toolbar">
    <button data-scenario="aberta" class="active">Central aberta</button>
    <button data-scenario="fechada">Central fechada</button>
    <span id="caption"></span>
  </div>
  <div class="message">
    <div class="avatar">🎧</div>
    <div class="body">
      <div class="author">VANTUS ATENDIMENTO <span class="bot-tag">APP</span>
        <span class="timestamp" id="clock"></span>
      </div>
      <div class="components" id="root"></div>
    </div>
  </div>
  <div class="note">
    Pré-visualização aproximada do painel público em <strong>Components V2</strong>
    (<code>panel_style=modern</code>). No Discord, cada card ganha a barra colorida de destaque
    à esquerda, e os botões abaixo do texto são funcionais.<br>
    Para voltar ao layout em embed: <code>/config definir chave:panel_style valor:classic</code>.
  </div>
</div>
<script>
const PAYLOADS = ${JSON.stringify(payloads)};
const COLORS = {
  16086040: '#ff7a18', 9124596: '#8b5cf6', 16723349: '#ff2d95', 3719160: '#38bdf8',
  2288663: '#22c55e', 15680580: '#ef4444', 7038819: '#6b7280', 9144318: '#8b5cf6',
};

function colorOf(value) {
  if (value === undefined || value === null) return '#5865f2';
  if (typeof value === 'number') return COLORS[value] || '#' + value.toString(16).padStart(6, '0');
  return value;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}

/** Markdown mínimo do Discord: #, ##, ###, -# (subtexto) e **negrito**. */
function renderMarkdown(content) {
  const lines = String(content).split('\\n');
  let html = '';
  for (const line of lines) {
    let text = escapeHtml(line);
    if (text.startsWith('### ')) {
      html += '<div class="text"><h3>' + inline(text.slice(4)) + '</h3></div>';
    } else if (text.startsWith('## ')) {
      html += '<div class="text"><h2>' + inline(text.slice(3)) + '</h2></div>';
    } else if (text.startsWith('# ')) {
      html += '<div class="text"><h1>' + inline(text.slice(2)) + '</h1></div>';
    } else if (text.startsWith('-# ')) {
      html += '<div class="text subtext">' + inline(text.slice(3)) + '</div>';
    } else if (text.trim() === '') {
      html += '<div style="height:4px"></div>';
    } else {
      html += '<div class="text">' + inline(text) + '</div>';
    }
  }
  return html;
}

function inline(text) {
  return text
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/&lt;#(\\d+)&gt;/g, '<span class="mention">#canal-de-voz</span>')
    .replace(/<#(\\d+)>/g, '<span class="mention">#canal-de-voz</span>');
}

function renderComponent(component) {
  switch (component.type) {
    case 17: { // container
      const inner = (component.components || []).map(renderComponent).join('');
      const tight = (component.components || []).length === 1 && component.components[0].type === 10
        && !String(component.components[0].content).includes('**');
      return '<div class="card' + (tight ? ' tight' : '') + '" style="--accent:' + colorOf(component.accent_color) + '">' + inner + '</div>';
    }
    case 10: { // text display
      const content = renderMarkdown(component.content);
      // "**ROTULO**" seguido de "## valor" vira um bloco de indicador.
      const labelPrefix = '<div class="text"><strong>';
      const valueMarker = '</div><div class="text"><h2>';
      if (content.startsWith(labelPrefix)) {
        const labelEnd = content.indexOf('</strong>' + valueMarker);
        const valueEnd = labelEnd >= 0 ? content.indexOf('</h2></div>', labelEnd) : -1;
        if (labelEnd > 0 && valueEnd > 0) {
          const label = content.slice(labelPrefix.length, labelEnd);
          const value = content.slice(labelEnd + ('</strong>' + valueMarker).length, valueEnd);
          const rest = content.slice(valueEnd + '</h2></div>'.length);
          return (
            '<div class="stat-label">' + label + '</div>' +
            '<div class="stat-value">' + value + '</div>' +
            rest
          );
        }
      }
      return content;
    }
    case 14: // separator
      return '<div class="sep"></div>';
    case 9: { // section
      const inner = (component.components || []).map(renderComponent).join('');
      const accessory = component.accessory;
      const thumb = accessory && accessory.type === 11 && accessory.media?.url
        ? '<div class="thumb">🎧</div>'
        : '<div class="thumb">🎧</div>';
      return '<div class="section">' + inner + thumb + '</div>';
    }
    case 1: // action row
      return '<div class="row">' + (component.components || []).map(renderComponent).join('') + '</div>';
    case 2: { // button
      const style = ['secondary', 'primary', 'success', 'danger'][(component.style ?? 2) - 1] || 'secondary';
      const emoji = component.emoji?.name ? component.emoji.name + ' ' : '';
      return '<button class="btn ' + style + '">' + emoji + escapeHtml(component.label || '') + '</button>';
    }
    default:
      return '';
  }
}

let current = 'aberta';
function render(scenarioKey) {
  current = scenarioKey;
  const payload = PAYLOADS[scenarioKey];
  document.getElementById('root').innerHTML = (payload.components || []).map(renderComponent).join('');
  document.getElementById('caption').textContent =
    scenarioKey === 'aberta' ? 'fila com 3 jogadores • 3 staffs disponíveis • 2 em atendimento' : 'fila vazia • sem staff em serviço';
  document.querySelectorAll('.toolbar button').forEach((button) => {
    button.classList.toggle('active', button.dataset.scenario === scenarioKey);
  });
}

document.querySelectorAll('.toolbar button').forEach((button) => {
  button.addEventListener('click', () => render(button.dataset.scenario));
});

const now = new Date();
document.getElementById('clock').textContent = 'hoje às ' +
  String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

render(current);
</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`✔ Pré-visualização gerada: ${path.relative(process.cwd(), outFile)}`);
