'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS } = require('../../config/theme');
const { SETTINGS, VALID_GROUPS, coerceValue } = require('../../config/settings');

function formatValue(value) {
  if (Array.isArray(value)) return value.length ? value.map((item) => `\`${item}\``).join(', ') : '_vazio_';
  if (value && typeof value === 'object') return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  if (value === null || value === undefined) return '_não definido_';
  return `\`${value}\``;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Consulta e altera as configurações do bot')
    .addSubcommand((sub) =>
      sub
        .setName('ver')
        .setDescription('Lista as configurações atuais')
        .addStringOption((option) =>
          option
            .setName('grupo')
            .setDescription('Filtrar por grupo')
            .setRequired(false)
            .addChoices(...VALID_GROUPS.slice(0, 25).map((group) => ({ name: group, value: group }))),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('definir')
        .setDescription('Altera uma configuração')
        .addStringOption((option) =>
          option
            .setName('chave')
            .setDescription('Chave da configuração (autocomplete)')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addStringOption((option) =>
          option
            .setName('valor')
            .setDescription('Novo valor (JSON para listas/agenda)')
            .setRequired(true)
            .setMaxLength(2000),
        ),
    ),

  async autocomplete({ interaction }) {
    const focused = interaction.options.getFocused(true);
    const query = String(focused.value || '').toLowerCase();
    const choices = Object.entries(SETTINGS)
      .filter(
        ([key, def]) =>
          key.includes(query) || def.label.toLowerCase().includes(query),
      )
      .slice(0, 25)
      .map(([key, def]) => ({ name: `${def.label} (${key})`.slice(0, 100), value: key }));
    await interaction.respond(choices).catch(() => null);
  },

  async execute({ interaction, services }) {
    const sub = interaction.options.getSubcommand();
    const settings = services.settings;

    try {
      if (sub === 'ver') {
        const group = interaction.options.getString('grupo');
        const all = settings.getAll();
        const entries = Object.entries(SETTINGS).filter(([, def]) => !group || def.group === group);

        const chunks = [];
        let current = '';
        for (const [key, def] of entries) {
          const line = `**${def.label}**\n\`${key}\` → ${formatValue(all[key])}\n`;
          if ((current + line).length > 3800) {
            chunks.push(current);
            current = '';
          }
          current += line;
        }
        if (current) chunks.push(current);

        return respond(
          interaction,
          ephemeral({
            embeds: chunks.slice(0, 5).map((text, index) =>
              card({
                title: index === 0 ? '⚙️ Configurações atuais' : '⚙️ Configurações (continuação)',
                description: text,
                color: COLORS.PURPLE,
              }),
            ),
          }),
        );
      }

      const key = interaction.options.getString('chave');
      const rawValue = interaction.options.getString('valor');
      const def = SETTINGS[key];
      if (!def) {
        return respond(interaction, ephemeral({ content: `Configuração \`${key}\` não existe.` }));
      }

      const previous = settings.get(key);
      const coerced = coerceValue(key, rawValue);
      if (!coerced.ok) {
        return respond(interaction, ephemeral({ content: `⛔ ${coerced.error}` }));
      }

      await settings.set(key, coerced.value);
      await services.audit.log({
        guildId: interaction.guildId,
        type: 'CONFIG_UPDATE',
        actorId: interaction.user.id,
        actorTag: interaction.member.displayName,
        message: `⚙️ <@${interaction.user.id}> alterou \`${key}\`:\n**Antes:** ${formatValue(previous)}\n**Agora:** ${formatValue(coerced.value)}`,
        color: COLORS.INFO,
      });
      await services.panels.refresh(interaction.guildId).catch(() => null);

      return respond(
        interaction,
        ephemeral({
          embeds: [
            card({
              title: '✅ Configuração atualizada',
              description: `**${def.label}**\n\`${key}\`\n\n**Antes:** ${formatValue(previous)}\n**Agora:** ${formatValue(coerced.value)}`,
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
