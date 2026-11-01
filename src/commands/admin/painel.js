'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');

const PANEL_CHOICES = [
  { name: 'Painel público', value: 'public' },
  { name: 'Painel da staff', value: 'staff' },
  { name: 'Ambos', value: 'both' },
];

function targets(value) {
  return value === 'both' ? ['public', 'staff'] : [value];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('painel')
    .setDescription('Gerencia os painéis de atendimento')
    .addSubcommand((sub) =>
      sub
        .setName('publicar')
        .setDescription('Publica (ou atualiza) os painéis nos canais configurados')
        .addStringOption((option) =>
          option.setName('painel').setDescription('Qual painel').addChoices(...PANEL_CHOICES).setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('atualizar')
        .setDescription('Força a atualização das informações dos painéis'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reconstruir')
        .setDescription('Apaga e recria a mensagem do painel (use se foi apagada à mão)')
        .addStringOption((option) =>
          option.setName('painel').setDescription('Qual painel').addChoices(...PANEL_CHOICES).setRequired(true),
        ),
    ),

  async execute({ interaction, services }) {
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'atualizar') {
        await services.panels.refresh(guildId);
        return respond(
          interaction,
          ephemeral({
            embeds: [
              card({
                title: '🔄 Painéis atualizados',
                description: 'As informações foram recarregadas com sucesso.',
                color: COLORS.SUCCESS,
              }),
            ],
          }),
        );
      }

      const selection = interaction.options.getString('painel');
      const list = targets(selection);
      const results = [];

      for (const key of list) {
        const channelId = services.panels.defaultChannel(key);
        if (!channelId) {
          results.push(`⚠️ **${key}**: canal não configurado (\`/config definir\`).`);
          continue;
        }
        const result =
          sub === 'reconstruir'
            ? await services.panels.rebuild(guildId, key, channelId)
            : await services.panels.publish(guildId, key, channelId);
        results.push(
          `${key === 'public' ? '📋 Público' : '🛡️ Staff'}: ${
            result.mode === 'created' ? 'publicado' : result.mode === 'edited' ? 'atualizado' : 'recriado'
          } em <#${result.channel_id}>`,
        );
      }

      await services.audit.log({
        guildId,
        type: 'PANEL_PUBLISH',
        actorId: interaction.user.id,
        actorTag: interaction.member.displayName,
        message: `🖼️ <@${interaction.user.id}> executou **/painel ${sub}** (${selection}).`,
        color: COLORS.PURPLE,
      });

      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '🖼️ Painéis processados',
              description: results.join('\n'),
              color: COLORS.SUCCESS,
            }),
          ],
        }),
      );
    } catch (error) {
      return respondError(interaction, error);
    }
  },
};
