'use strict';

/**
 * Pré-visualização do painel da equipe (staff).
 *   npm run preview:staff  →  preview/staff.html
 *
 * O HTML renderiza EXATAMENTE o payload produzido por `buildStaffPanel`
 * (embed + botões), aplicando a paleta da identidade visual da VANTUS
 * (`src/config/theme.js`). Nada de conteúdo inventado pela prévia: título,
 * descrição, campos e botões vêm do painel real; apenas o estado de exemplo
 * (fila/atendimentos) é montado para a demonstração.
 */
const fs = require('node:fs');
const path = require('node:path');
const { PALETTE, BRAND } = require('../src/config/theme');
const { buildStaffPanel } = require('../src/dashboard/panels/staffPanel');

const root = path.join(__dirname, '..');
const outFile = path.join(root, 'preview', 'staff.html');

const hex = (value) => `#${Number(value).toString(16).padStart(6, '0')}`;

const MINUTE = 60 * 1000;
const now = new Date();

function demoState() {
  const waiting = [
    { id: 1, position: 1, username: 'pedrosa17', protocol: 23, joined_at: now - 12 * MINUTE, waitingSeconds: 12 * 60 },
    { id: 2, position: 2, username: 'gabriel_tt', protocol: 24, joined_at: now - 7 * MINUTE, waitingSeconds: 7 * 60 },
    { id: 3, position: 3, username: 'lucas.v', protocol: 25, joined_at: now - 3 * MINUTE, waitingSeconds: 3 * 60, order_override: true },
  ];
  const serving = [
    {
      id: 4,
      username: 'caiozin',
      protocol: 22,
      staff_id: '900000000000000001',
      started_at: now - 9 * MINUTE,
      servingSeconds: 9 * 60,
      presence_confirmed: true,
    },
  ];
  const staffList = [
    { userId: '900000000000000001', status: 'EM_ATENDIMENTO', meta: { emoji: '🔴', label: 'EM ATENDIMENTO' } },
    { userId: '900000000000000002', status: 'DISPONIVEL', meta: { emoji: '🟢', label: 'DISPONÍVEL' } },
  ];
  return {
    waiting,
    serving,
    hold: [{ id: 5, username: 'mika', protocol: 21, hold_reason: 'não respondeu à chamada' }],
    staffList,
    staffCounts: { DISPONIVEL: 1, EM_ATENDIMENTO: 1, AUSENTE: 0, INDISPONIVEL: 0 },
    avgWaitSeconds: 7 * 60,
  };
}

function build() {
  const state = demoState();
  const payload = buildStaffPanel({
    state,
    overview: { avgDurationSeconds: 11 * 60, concluded: 7, evaluations: 5, avgRating: 3.4 },
    schedule: { open: true },
    todayWindow: { text: '12:00 às 02:00' },
    now,
  });
  return { payload, state };
}

/** Markdown mínimo do Discord → HTML (negrito, itálico, código e menções). */
function md(text) {
  const escaped = String(text)
    .replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));

  return escaped
    .replace(/&lt;@!?(\d+)&gt;/g, '<span class="mention">@$1</span>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\u0060([^\u0060]+)\u0060/g, '<code>$1</code>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
}

function renderEmbed(embed) {
  const fields = (embed.fields ?? [])
    .map(
      (field) =>
        '<div class="field">' +
        '<div class="field-name">' + md(field.name) + '</div>' +
        '<div class="field-value">' + md(field.value) + '</div>' +
        '</div>',
    )
    .join('');

  return (
    '<div class="embed" style="border-left-color:' + hex(embed.color) + '">' +
    (embed.title ? '<div class="embed-title">' + md(embed.title) + '</div>' : '') +
    (embed.description ? '<div class="embed-desc">' + md(embed.description) + '</div>' : '') +
    (fields ? '<div class="fields">' + fields + '</div>' : '') +
    (embed.footer ? '<div class="embed-footer">' + md(embed.footer.text) + '</div>' : '') +
    '</div>'
  );
}

function renderButtons(rows) {
  return rows
    .map(
      (row) =>
        '<div class="row">' +
        row.components
          .map(
            (button) =>
              '<button type="button" class="btn' +
              (button.disabled ? ' disabled' : '') +
              '"' +
              (button.disabled ? ' disabled' : '') +
              '>' +
              (button.emoji ? '<span class="btn-emoji">' + button.emoji.name + '</span>' : '') +
              '<span>' + md(button.label) + '</span>' +
              '</button>',
          )
          .join('') +
        '</div>',
    )
    .join('');
}

const { payload } = build();
const embed = payload.embeds[0];

const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VANTUS • Painel da equipe</title>
<style>
  :root {
    --page: ${hex(PALETTE.INK)};
    --container: ${hex(PALETTE.BLACK)};
    --surface: ${hex(PALETTE.SURFACE)};
    --line: ${hex(PALETTE.BORDER)};
    --text: ${hex(PALETTE.TEXT)};
    --muted: ${hex(PALETTE.MUTED)};
    --accent: ${hex(PALETTE.RED)};
    --accent-deep: ${hex(PALETTE.RED_DEEP)};
    --dim: #7c8085;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--page); }
  body {
    color: var(--text);
    font-family: "gg sans", "Inter", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
    padding: 26px 16px 60px;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 680px; margin: 0 auto; }
  .links { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .links a {
    color: var(--muted); text-decoration: none; font-size: 12.5px; font-weight: 600;
    background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 7px 13px;
  }
  .links a.active { color: var(--text); border-color: var(--accent); }
  .author { font-size: 14.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .bot-tag { background: var(--accent); color: #fff; font-size: 10px; font-weight: 700; border-radius: 3px; padding: 1px 4px; }
  .timestamp { color: var(--dim); font-size: 11.5px; font-weight: 400; }
  .embed {
    margin-top: 9px;
    background: var(--container);
    border: 1px solid var(--line);
    border-left: 4px solid var(--accent);
    border-radius: 10px;
    padding: 16px 18px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, .35);
  }
  .embed-title { font-size: 16.5px; font-weight: 800; letter-spacing: .2px; }
  .embed-desc {
    margin-top: 10px; font-size: 13.5px; line-height: 1.62; color: #dcdddf;
    white-space: pre-wrap;
  }
  .embed-desc strong { color: var(--text); font-weight: 700; }
  .embed-desc em { color: var(--muted); }
  .embed-desc code, .field-value code {
    background: var(--surface); border: 1px solid var(--line); border-radius: 4px;
    padding: 0 4px; font-size: 12px;
  }
  .mention {
    background: rgba(255, 34, 0, .16); color: #ff8f7a;
    border-radius: 4px; padding: 0 3px; font-weight: 600;
  }
  .fields {
    display: grid; grid-template-columns: repeat(3, 1fr);
    gap: 12px 10px; margin-top: 16px;
    border-top: 1px solid var(--line); padding-top: 14px;
  }
  .field-name { font-size: 11.5px; font-weight: 700; color: var(--muted); letter-spacing: .02em; }
  .field-value { margin-top: 3px; font-size: 14px; font-weight: 700; color: var(--text); }
  .embed-footer { margin-top: 14px; font-size: 11.5px; color: var(--muted); }
  .row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .row:first-of-type { margin-top: 12px; }
  .btn {
    display: inline-flex; align-items: center; gap: 7px;
    background: var(--surface); color: var(--text);
    border: 1px solid var(--line); border-radius: 8px;
    padding: 9px 14px; font-size: 12.5px; font-weight: 700; letter-spacing: .01em;
    font-family: inherit; cursor: default;
  }
  .btn:hover { border-color: var(--accent); }
  .btn.disabled { opacity: .45; }
  .btn-emoji { font-size: 13.5px; }
  .note {
    margin-top: 22px; padding-top: 14px; border-top: 1px solid var(--line);
    color: var(--muted); font-size: 11.5px; line-height: 1.6;
  }
  .note code { background: var(--surface); border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
  @media (max-width: 560px) {
    .fields { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="links">
    <a href="panel.html">Painel público</a>
    <a href="staff.html" class="active">Painel da equipe</a>
  </div>

  <div class="author">${BRAND.name} ATENDIMENTO <span class="bot-tag">APP</span>
    <span class="timestamp">hoje às ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}</span>
  </div>

  ${renderEmbed(embed)}
  ${renderButtons(payload.components)}

  <div class="note">
    Renderização fiel do payload real de <code>buildStaffPanel</code>: embed com barra de destaque
    <strong>${hex(embed.color)}</strong>, campos e botões. No Discord os botões usam a superfície neutra
    (estilo <em>Secondary</em>) porque a API não aceita cor personalizada — o destaque da marca fica no
    ícone e na barra do embed.
  </div>
</div>
</body>
</html>
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`✔ Pré-visualização gerada: ${path.relative(process.cwd(), outFile)}`);
