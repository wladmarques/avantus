'use strict';

/**
 * Gera as artes do painel da central (relógio grande ao lado do status).
 *
 *   npm run art   →  assets/central-*.png
 *
 * Por que gerar em vez de guardar um print: o painel usa a mesma arte em três
 * estados (fechada / sem staff / disponível), e o desenho precisa ser nítido em
 * qualquer tamanho de tela. Os PNGs ficam pequenos (~3 KB) porque são formas
 * chapadas em uma única cor sobre fundo transparente.
 *
 * Sem dependências: o PNG é montado à mão (zlib só para comprimir o IDAT).
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'assets');

const SIZE = 320;

/** Cores dos três estados (as mesmas dos indicadores do painel). */
const VARIANTS = {
  'central-fechada': [0xff, 0x22, 0x00], // vermelho da marca
  'central-sem-staff': [0xf0, 0xb4, 0x29], // âmbar: aberta, mas ninguém em serviço
  'central-disponivel': [0x22, 0xc5, 0x5e], // verde: pronto para atender
};

/* -------------------------------------------------------------------------- */
/* Desenho (campos de distância: a borda já sai suave, sem serrilhado)         */
/* -------------------------------------------------------------------------- */

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Cobertura de um anel: |distância até o raio| menor que meia espessura. */
function ringCoverage(distance, radius, thickness) {
  const half = thickness / 2;
  return clamp01(half + 0.5 - Math.abs(distance - radius));
}

/** Distância de um ponto ao segmento (usada para os ponteiros). */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : clamp01(((px - ax) * dx + (py - ay) * dy) / lengthSquared);
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Cobertura de um ponteiro (segmento com pontas arredondadas). */
function handCoverage(px, py, angle, length, thickness) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  // 0° aponta para cima (12 horas) e cresce no sentido horário.
  const radians = ((angle - 90) * Math.PI) / 180;
  const ax = cx + Math.cos(radians) * 18;
  const ay = cy + Math.sin(radians) * 18;
  const bx = cx + Math.cos(radians) * length;
  const by = cy + Math.sin(radians) * length;
  return clamp01(thickness / 2 + 0.5 - distanceToSegment(px, py, ax, ay, bx, by));
}

/** Desenha o relógio inteiro e devolve os pixels RGBA. */
function drawClock([r, g, b]) {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const center = SIZE / 2;
  const radius = 118;
  const ringThickness = 20;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const distance = Math.hypot(px - center, py - center);

      // Anel externo + ponteiros (hora em 12, minuto em 4 — leitura de relógio).
      let alpha = ringCoverage(distance, radius, ringThickness);
      alpha = Math.max(alpha, handCoverage(px, py, 0, 72, 17));
      alpha = Math.max(alpha, handCoverage(px, py, 120, 92, 17));
      // Pino central arredondado.
      alpha = Math.max(alpha, clamp01(11 + 0.5 - distance));

      const offset = (y * SIZE + x) * 4;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = Math.round(clamp01(alpha) * 255);
    }
  }

  return pixels;
}

/* -------------------------------------------------------------------------- */
/* Codificador PNG (8 bits, RGBA, sem filtro — formas chapadas comprimem bem)  */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(pixels, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits por canal
  header[9] = 6; // RGBA
  header[10] = 0; // compressão deflate
  header[11] = 0; // filtro padrão
  header[12] = 0; // sem entrelaçamento

  // Uma linha = 1 byte de filtro (0 = nenhum) + pixels.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function main() {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, color] of Object.entries(VARIANTS)) {
    const png = encodePng(drawClock(color), SIZE, SIZE);
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, png);
    console.log(`✔ ${path.relative(root, file)} • ${(png.length / 1024).toFixed(1)} KB`);
  }
  console.log('\nArtes geradas. Elas entram no pacote de deploy automaticamente.');
}

if (require.main === module) main();

module.exports = { VARIANTS, SIZE, encodePng, drawClock };
