'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');
const { describeSchedule } = require('../../utils/time');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ajuda')
    .setDescription('Como funciona o atendimento da VANTUS'),
  async execute({ interaction, services }) {
    const status = services.central.status(interaction.guildId);
    return respond(
      interaction,
      ephemeral({
        embeds: [
          card({
            title: '🎧 Central de Atendimento VANTUS',
            description: [
              '**Como pedir ajuda**',
              '1. Vá até o canal do painel de atendimento e clique em **🎫 ENTRAR NA FILA**.',
              '2. Entre no canal de voz **AGUARDANDO ATENDIMENTO**.',
              '3. Aguarde: você receberá uma mensagem privada quando um staff te chamar.',
              '4. Compareça ao canal de voz indicado para o atendimento.',
              '',
              '**Comandos úteis**',
              '`/entrar` — entrar na fila',
              '`/sair` — desistir do atendimento',
              '`/posicao` — ver sua posição',
              '`/protocolo` — consultar seu protocolo',
            ].join('\n'),
            fields: [
              { name: '📊 Central', value: status.open ? '🟢 ABERTA' : '📕 FECHADA', inline: true },
              { name: '⏰ Hoje', value: status.today.text, inline: true },
              { name: '🗓️ Horários', value: describeSchedule(services.settings.get('schedule')) },
            ],
            color: COLORS.ORANGE,
          }),
        ],
      }),
    );
  },
};
