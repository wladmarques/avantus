'use strict';

/**
 * Pré-visualização do painel público.
 *   npm run preview:panel  →  preview/panel.html
 *
 * Diferente de um mockup, aqui o HTML é gerado a partir do **payload real** de
 * `buildPublicPanelV2`. O script só traduz Components V2 (container, section,
 * text display, separator, botão) para HTML — se o painel mudar, a prévia muda
 * junto. As artes entram embutidas em base64, então o arquivo abre sozinho.
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildPublicPanelV2, statusInfo, ART } = require('../src/dashboard/panels/publicPanel');
const { DEFAULT_SCHEDULE } = require('../src/config/settings');

const root = path.join(__dirname, '..');
const outFile = path.join(root, 'preview', 'panel.html');

const STATUS_COLORS = { 'central-fechada': '#ff2200', 'central-sem-staff': '#f0b429', 'central-disponivel': '#22c55e' };

const settings = {
  message_panel_title: 'ATENDIMENTO | HYPE',
  wait_channel_id: '000000000000000000',
};

const scenarios = {
  fechada: {
    label: 'Fora do horário',
    state: { waiting: [], serving: [], staffCounts: { DISPONIVEL: 0 } },
    schedule: { open: false, nextOpen: 'hoje às 12:00', schedule: DEFAULT_SCHEDULE },
  },
  disponivel: {
    label: 'Aberta e disponível',
    state: { waiting: [], serving: [], staffCounts: { DISPONIVEL: 2 } },
    schedule: { open: true, nextOpen: null, schedule: DEFAULT_SCHEDULE },
  },
  fila: {
    label: 'Com fila e atendimento',
    state: { waiting: [1, 2, 3], serving: [1], staffCounts: { DISPONIVEL: 2 } },
    schedule: { open: true, nextOpen: null, schedule: DEFAULT_SCHEDULE },
  },
  sem_staff: {
    label: 'Aberta sem staff',
    state: { waiting: [1], serving: [], staffCounts: { DISPONIVEL: 0 } },
    schedule: { open: true, nextOpen: null, schedule: DEFAULT_SCHEDULE },
  },
};

/** Artes embutidas como data URI (o `attachment://` vira o PNG correspondente). */
const artDataUris = Object.fromEntries(
  Object.values(ART).map((art) => {
    const file = path.join(root, 'assets', art.file);
    const base64 = fs.readFileSync(file).toString('base64');
    return [`attachment://${art.file}`, `data:image/png;base64,${base64}`];
  }),
);

const models = Object.fromEntries(
  Object.entries(scenarios).map(([key, scenario]) => {
    const built = buildPublicPanelV2({
      settings,
      state: scenario.state,
      schedule: scenario.schedule,
      now: new Date(),
    });
    return [
      key,
      {
        label: scenario.label,
        components: built.payload.components,
        artColor: STATUS_COLORS[statusArtFile(scenario)?.replace('.png', '')] ?? '#ff2200',
      },
    ];
  }),
);

function statusArtFile({ state, schedule }) {
  const available = state.staffCounts.DISPONIVEL ?? 0;
  if (!schedule.open) return 'central-fechada.png';
  return available > 0 ? 'central-disponivel.png' : 'central-sem-staff.png';
}

// Sanidade: o status usado na prévia é o mesmo do painel publicado.
const sanity = statusInfo({ open: false, availableStaff: 0, nextOpen: 'hoje às 12:00' });
if (!sanity.headline.includes('FORA DO HORÁRIO')) {
  throw new Error('statusInfo divergente na geração da pré-visualização.');
}

const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VANTUS • Painel de atendimento</title>
<style>
  :root {
    --page: #090a0b;
    --container: #0b0c0d;
    --box: #17181a;
    --line: #252629;
    --text: #e6e6e6;
    --muted: #acaeb1;
    --dim: #7c8085;
    --accent: #ff2200;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--page); }
  body {
    color: var(--text);
    font-family: "gg sans", "Inter", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
    padding: 26px 16px 60px;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 660px; margin: 0 auto; }

  .links { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .links a {
    color: var(--muted); text-decoration: none; font-size: 12.5px; font-weight: 600;
    background: #1a1b1d; border: 1px solid var(--line); border-radius: 8px; padding: 7px 13px;
  }
  .links a.active { color: var(--text); border-color: var(--accent); }
  .toolbar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .toolbar button {
    background: #1a1b1d; color: var(--muted); border: 1px solid var(--line);
    border-radius: 8px; padding: 7px 13px; font-size: 12.5px; font-weight: 600;
    cursor: pointer; transition: .15s ease;
  }
  .toolbar button:hover { color: var(--text); }
  .toolbar button.active { background: #23252c; color: var(--text); border-color: var(--accent); }

  .author { font-size: 14.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .bot-tag { background: #5865f2; font-size: 10px; font-weight: 700; border-radius: 3px; padding: 1px 4px; }
  .timestamp { color: var(--dim); font-size: 11.5px; font-weight: 400; }

  /* Containers (type 17) — empilhados, cada um com sua barra de destaque */
  .container {
    margin-top: 10px;
    background: var(--container);
    border: 1px solid var(--line);
    border-left: 4px solid var(--accent);
    border-radius: 12px;
    padding: 16px 18px;
  }
  .container.plain { border-left-color: var(--line); }
  .md p { margin: 0; line-height: 1.45; }
  .md h1 { margin: 0; font-size: 24px; font-weight: 800; letter-spacing: .2px; text-transform: uppercase; }
  .md h2 { margin: 0; font-size: 20px; font-weight: 800; letter-spacing: .2px; }
  .md small { font-size: 12px; color: var(--dim); }
  .md b { font-weight: 800; }
  .md code { background: #1f2023; border-radius: 4px; padding: 1px 5px; font-size: .92em; }
  .md .mention { color: #c9cdfb; background: #3c4270; border-radius: 4px; padding: 0 4px; }

  /* Métricas: caixa própria, número grande */
  .metric h1 { font-size: 24px; }

  /* Section (type 9): texto à esquerda, acessório à direita */
  .section { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
  .section .md { min-width: 0; }
  .thumb { width: 96px; height: 96px; flex: 0 0 96px; }
  .sep { height: 1px; background: var(--line); margin: 14px 0; }
  .space { height: 12px; }

  .btn {
    display: inline-flex; align-items: center; gap: 8px;
    background: #1a1b1d; color: var(--text);
    border: 1px solid var(--line); border-radius: 8px;
    padding: 9px 16px; font-size: 13px; font-weight: 700;
    cursor: default; white-space: nowrap; flex: 0 0 auto;
  }
  .btn.disabled { opacity: .45; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }

  .note {
    margin-top: 22px; padding-top: 14px; border-top: 1px solid var(--line);
    color: var(--dim); font-size: 11.5px; line-height: 1.6;
  }
  @media (max-width: 560px) {
    .thumb { width: 72px; height: 72px; flex-basis: 72px; }
    .section { align-items: flex-start; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="links">
    <a href="panel.html" class="active">Painel público</a>
    <a href="staff.html">Painel da equipe</a>
  </div>
  <div class="toolbar" id="toolbar"></div>

  <div class="author">VANTUS ATENDIMENTO <span class="bot-tag">APP</span>
    <span class="timestamp" id="clock"></span>
  </div>
  <div id="message"></div>

  <div class="note">
    Renderizado a partir do <strong>payload real</strong> de Components V2 (container, section,
    text display, separator e botão) com as artes de <code>assets/</code>. No Discord o resultado é
    este: um container por caixa, porque a API não permite aninhar containers.
  </div>
</div>
<script>
const MODELS = ${JSON.stringify(models)};
const ART = ${JSON.stringify(artDataUris)};
const ORDER = ${JSON.stringify(Object.keys(scenarios))};

function esc(value) {
  return String(value).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/** Markdown do Discord que o painel usa: # ## -# **negrito** \`código\` <#canal> */
function markdown(content) {
  return content
    .split('\\n')
    .map((line) => {
      let cls = '';
      let body = line;
      if (body.startsWith('## ')) { cls = 'h2'; body = body.slice(3); }
      else if (body.startsWith('# ')) { cls = 'h1'; body = body.slice(2); }
      else if (body.startsWith('-# ')) { cls = 'small'; body = body.slice(3); }

      body = esc(body)
        .replace(/\\*\\*(.+?)\\*\\*/g, '<b>$1</b>')
        .replace(/\`(.+?)\`/g, '<code>$1</code>')
        .replace(/&lt;#(\\d+)&gt;/g, '<span class="mention">#aguardando-atendimento</span>');

      return cls ? \`<\${cls === 'small' ? 'small' : cls}>\${body}</\${cls === 'small' ? 'small' : cls}>\` : \`<p>\${body}</p>\`;
    })
    .join('');
}

function renderComponent(component, model) {
  if (component.type === 10) {
    return \`<div class="md">\${markdown(component.content)}</div>\`;
  }
  if (component.type === 14) {
    return component.divider ? '<div class="sep"></div>' : '<div class="space"></div>';
  }
  if (component.type === 1) {
    return \`<div class="row">\${component.components.map((c) => renderButton(c)).join('')}</div>\`;
  }
  if (component.type === 9) {
    const inner = component.components.map((c) => renderComponent(c, model)).join('');
    const accessory = component.accessory;
    let right = '';
    if (accessory?.type === 11) {
      const src = ART[accessory.media.url] ?? '';
      right = \`<img class="thumb" src="\${src}" alt="\${esc(accessory.description ?? '')}">\`;
    } else if (accessory) {
      right = renderButton(accessory);
    }
    return \`<div class="section"><div>\${inner}</div>\${right}</div>\`;
  }
  if (component.type === 17) {
    const accent = component.accent_color;
    const color = accent
      ? \`#\${accent.toString(16).padStart(6, '0')}\`
      : 'var(--line)';
    const plain = !accent;
    const metric = component.components.some((c) => c.type === 10 && /^# \\d+$/m.test(c.content));
    return \`<div class="container\${plain ? ' plain' : ''} \${metric ? 'metric' : ''}" style="border-left-color:\${color}">\` +
      component.components.map((c) => renderComponent(c, model)).join('') +
      '</div>';
  }
  return '';
}

function renderButton(component) {
  const emoji = component.emoji ? \`<span>\${component.emoji.name}</span>\` : '';
  return \`<span class="btn\${component.disabled ? ' disabled' : ''}">\${emoji}<span>\${esc(component.label)}</span></span>\`;
}

function render(key) {
  const model = MODELS[key];
  if (!model) return;
  document.getElementById('message').innerHTML = model.components.map((c) => renderComponent(c, model)).join('');
  document.getElementById('clock').textContent = 'Hoje às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  window.location.hash = key;
  document.querySelectorAll('#toolbar button').forEach((button) => {
    button.classList.toggle('active', button.dataset.key === key);
  });
}

document.getElementById('toolbar').innerHTML = ORDER.map(
  (key) => \`<button type="button" data-key="\${key}">\${MODELS[key].label}</button>\`,
).join('');
document.querySelectorAll('#toolbar button').forEach((button) => {
  button.addEventListener('click', () => render(button.dataset.key));
});

render(window.location.hash.replace('#', '') || ORDER[0]);
</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`✔ Pré-visualização gerada: ${path.relative(root, outFile)}`);
