'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, panelText, panelButtonIds, panelCards } = require('./helpers');

test('painel público moderno (Components V2) expõe indicadores e é atualizado na fila', async (t) => {
  // Sem staff disponível: central visível, entrada na fila bloqueada.
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);
  addMember(env.gateway, '900000000000003001');
  env.gateway.iconUrl = 'https://cdn.discordapp.com/icons/1/abc.png';

  const channelId = env.services.settings.get('public_channel_id');
  const published = await env.services.panels.publish(env.guildId, 'public', channelId);
  assert.equal(published.format, 'v2');

  const message = env.gateway.channelMessages.at(-1);
  assert.equal(message.payload.flags, 32768, 'usa MessageFlags.IsComponentsV2');
  assert.equal(message.payload.embeds, undefined, 'V2 não mistura embeds');

  // Caixas empilhadas: status + três indicadores + rodapé. O Discord não
  // permite aninhar containers, então cada caixa é um container irmão.
  const boxes = panelCards(message.payload).filter((box) => box.type === 17);
  assert.equal(boxes.length, 3, 'status + corpo + rodapé');

  const text = panelText(message.payload);
  assert.match(text, /ATENDIMENTO \| VANTUS/);
  assert.ok(!/🎧 🎧/.test(text), 'ícone do cabeçalho não duplica');
  assert.ok(!text.includes('STATUS DA CENTRAL'), 'sem rótulo redundante acima da manchete');
  assert.match(text, /AGUARDANDO STAFF/, 'sem staff: aguardando alguém da equipe');
  assert.match(text, /-# NA FILA\n# 0/, 'indicador em caixa própria, número grande');
  assert.match(text, /-# STAFFS DISPONÍVEIS\n# 0/);
  assert.match(text, /-# EM ANDAMENTO\n# 0/);
  assert.ok(!text.includes('ESPERA MÉDIA'), 'indicador de espera média removido do painel');
  assert.match(text, /HORÁRIO DE ATENDIMENTO/);
  assert.match(text, /Seg–Sex/);
  assert.match(text, /12:00 às 02:00/);
  assert.match(text, /Fila por canal de voz/);
  assert.match(text, /Você será movido automaticamente/);

  // A imagem do painel (relógio) viaja com a mensagem.
  assert.equal(message.payload.files.length, 1);
  assert.ok(message.payload.files[0].endsWith('central-sem-staff.png'), 'arte do estado atual');

  // Visual limpo: botão principal + avaliação sempre acessível
  assert.deepEqual(panelButtonIds(message.payload), ['pub:join', 'pub:evaluate']);

  // Cores: caixa de status pelo estado (âmbar sem staff) e rodapé na marca.
  assert.equal(boxes[0].accent_color, 0xf0b429, 'status âmbar: aberta sem staff');
  assert.equal(boxes.at(-1).accent_color, 0xff2200, 'rodapé na cor da marca (#ff2200)');
  assert.equal(boxes[1].accent_color, undefined, 'o corpo (indicadores + horário) é neutro');

  // O status usa o relógio grande à direita (section + thumbnail).
  const statusSection = boxes[0].components.find((component) => component.type === 9);
  assert.equal(statusSection.accessory.type, 11, 'acessório é a thumbnail do relógio');
  assert.match(statusSection.accessory.media.url, /^attachment:\/\/central-.+\.png$/);

  // Rodapé: texto à esquerda e botão principal à direita
  const footerSection = boxes.at(-1).components.find(
    (component) => component.type === 9 && component.accessory?.type === 2,
  );
  assert.ok(footerSection, 'seção com botão como accessory');
  assert.equal(footerSection.accessory.custom_id, 'pub:join');
  assert.equal(footerSection.accessory.style, 2, 'botão na superfície neutra da paleta (Secondary)');
  assert.equal(
    footerSection.accessory.disabled,
    true,
    'sem staff em serviço o botão Entrar na Fila fica desabilitado',
  );
  assert.match(text, /Entrada na fila indisponível: sem staff em serviço/);

  // Com staff em serviço a entrada é liberada e o painel volta a atualizar normalmente.
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: '910000000000003901',
    status: 'DISPONIVEL',
    updatedBy: 'sistema',
    manual: false,
  });
  await env.services.panels.refresh(env.guildId);

  const reopened = env.gateway.channelMessages.find((item) => item.id === message.id);
  const reopenedBoxes = panelCards(reopened.payload).filter((box) => box.type === 17);
  const reopenedSection = reopenedBoxes.at(-1).components.find(
    (component) => component.type === 9 && component.accessory?.type === 2,
  );
  assert.equal(reopenedSection.accessory.disabled, false, 'com staff o botão volta a funcionar');
  assert.equal(reopenedBoxes[0].accent_color, 0x22c55e, 'status verde: disponível');
  assert.ok(reopened.payload.files[0].endsWith('central-disponivel.png'), 'arte muda com o estado');

  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000003001', displayName: 'Teste' });
  await env.services.panels.refresh(env.guildId);

  const updated = env.gateway.channelMessages.find((item) => item.id === message.id);
  assert.match(panelText(updated.payload), /-# NA FILA\n# 1/);
});

test('status muda para DISPONÍVEL quando há staff livre', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: '910000000000003900',
    status: 'DISPONIVEL',
    updatedBy: 'sistema',
    manual: false,
  });

  const { payload } = env.services.panels.buildPayload(env.guildId, 'public');
  const text = panelText(payload);
  assert.match(text, /# DISPONÍVEL/);
  assert.match(text, /1 staff pronto para atender/);
});

test('estilo clássico continua disponível em embed', async (t) => {
  const env = await createTestEnv({ settings: { panel_style: 'classic' } });
  t.after(env.cleanup);

  const published = await env.services.panels.publish(env.guildId, 'public', env.services.settings.get('public_channel_id'));
  assert.equal(published.format, 'embed');

  const message = env.gateway.channelMessages.at(-1);
  assert.ok(message.payload.embeds?.length, 'payload em embed');
  assert.match(panelText(message.payload), /ATENDIMENTO \| VANTUS/);
  assert.deepEqual(panelButtonIds(message.payload), [
    'pub:join',
    'pub:leave',
    'pub:status',
    'pub:evaluate',
  ]);
});

test('trocar o estilo recria a mensagem sem duplicar o painel', async (t) => {
  const env = await createTestEnv({ settings: { panel_style: 'classic' } });
  t.after(env.cleanup);
  const channelId = env.services.settings.get('public_channel_id');

  const first = await env.services.panels.publish(env.guildId, 'public', channelId);
  assert.equal(first.format, 'embed');

  await env.services.settings.set('panel_style', 'modern');
  const second = await env.services.panels.publish(env.guildId, 'public', channelId);

  assert.equal(second.format, 'v2');
  assert.equal(env.gateway.deletedMessages.length, 1, 'mensagem antiga removida');
  const publicMessages = env.gateway.channelMessages.filter((item) => item.channelId === channelId);
  assert.equal(publicMessages.length, 2, 'uma antiga (apagada) + uma nova');
});

test('fallback: se o Discord recusar Components V2, publica o painel clássico', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  const channelId = env.services.settings.get('public_channel_id');

  const original = env.gateway.sendChannelMessage.bind(env.gateway);
  let attempts = 0;
  env.gateway.sendChannelMessage = async (guildId, channel, payload) => {
    attempts += 1;
    if (payload.flags === 32768) {
      const error = new Error('Invalid Form Body (components)');
      error.code = 50035;
      throw error;
    }
    return original(guildId, channel, payload);
  };

  const result = await env.services.panels.publish(env.guildId, 'public', channelId);
  assert.equal(result.format, 'embed');
  assert.equal(attempts, 2);
  assert.ok(env.gateway.channelMessages.at(-1).payload.embeds?.length);
});

test('painel da staff lista a fila com protocolo, entrada e espera', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, '900000000000003002');
  addMember(env.gateway, '900000000000003003');

  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000003002', displayName: 'Primeiro' });
  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000003003', displayName: 'Segundo' });

  const channelId = env.services.settings.get('staff_channel_id');
  await env.services.panels.publish(env.guildId, 'staff', channelId);
  const embed = env.gateway.channelMessages.at(-1).payload.embeds[0];

  assert.match(embed.title, /PAINEL DA EQUIPE/);
  assert.match(embed.description, /#01 — Primeiro/);
  assert.match(embed.description, /#02 — Segundo/);
  assert.match(embed.description, /Protocolo: `#0001`/);
  assert.match(embed.description, /Espera:/);
});

test('reconstruir painel apaga a mensagem antiga e publica uma nova', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  const channelId = env.services.settings.get('public_channel_id');

  const first = await env.services.panels.publish(env.guildId, 'public', channelId);
  const rebuilt = await env.services.panels.rebuild(env.guildId, 'public', channelId);

  assert.equal(env.gateway.deletedMessages.length, 1);
  assert.equal(env.gateway.channelMessages.length, 2);
  assert.notEqual(first.message_id, rebuilt.message_id);
});

test('painel indica central fechada fora do horário', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  await env.services.central.close({ guildId: env.guildId, actorId: '1', actorTag: 'Admin' });

  const { payload } = env.services.panels.buildPayload(env.guildId, 'public');
  const text = panelText(payload);
  assert.match(text, /CENTRAL FECHADA/, 'fechada pela administração');
  assert.match(text, /Fechada pela administração/);
  assert.match(text, /HORÁRIO DE ATENDIMENTO/);
  assert.ok(!/[🟢🟡🔴]/u.test(text), 'sem emoji de status no painel público');
});
