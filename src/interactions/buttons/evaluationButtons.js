'use strict';

const { defer, respond, respondError, ephemeral } = require('../../handlers/respond');
const { card } = require('../../dashboard/embeds/cards');
const { COLORS, RATING_META } = require('../../config/theme');
const { VALID_RATINGS } = require('../../systems/evaluations/evaluationService');

const EVAL_PREFIX = 'eval:';

function parseEvaluationId(customId) {
  const [, attendanceId, rating] = customId.split(':');
  if (!attendanceId || !rating) return null;
  if (!VALID_RATINGS.includes(rating)) return null;
  return { attendanceId: Number(attendanceId), rating };
}

async function handleEvaluation(interaction, { services }) {
  const parsed = parseEvaluationId(interaction.customId);
  if (!parsed) {
    return respond(interaction, ephemeral({ content: 'Avaliação inválida.' }));
  }

  await defer(interaction, { ephemeral: true });
  try {
    await services.evaluations.submit({
      guildId: interaction.guildId ?? services.settings.get('guild_id'),
      userId: interaction.user.id,
      attendanceId: parsed.attendanceId,
      rating: parsed.rating,
    });

    const meta = RATING_META[parsed.rating];
    await respond(
      interaction,
      ephemeral({
        embeds: [
          card({
            title: '⭐ Obrigado pela avaliação!',
            description: `Sua nota **${meta.label}** foi registrada.\n\nA equipe VANTUS agradece o seu feedback.`,
            color: COLORS.SUCCESS,
          }),
        ],
      }),
    );
  } catch (error) {
    return respondError(interaction, error);
  }
}

module.exports = { EVAL_PREFIX, parseEvaluationId, handleEvaluation };
