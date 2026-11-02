'use strict';

const { handleInteraction } = require('../../interactions/router');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction, context) {
    return handleInteraction(interaction, context);
  },
};
