const entities = require('@jetbrains/youtrack-scripting-api/entities');
const utils = require('./utils.js');

exports.rule = entities.Issue.onChange({
  title: 'Record timestamp when issue state is changed',
  guard: (ctx) => {
    const issue = ctx.issue;

    return issue.isReported && issue.fields.isChanged(ctx.State);
  },
  action: (ctx) => {
    const issue = ctx.issue;
    const settings = utils.getSettingsFromContext(ctx);

    if(settings.states.includes(issue.fields.State.name) && utils.isOnBoard(issue.boards, settings.board)) {
      issue.extensionProperties.lastMovedTimestamp = Date.now();
      issue.fields.staleLevel = ctx.staleLevel.check;
      return;
    }

    issue.extensionProperties.lastMovedTimestamp = null;
    issue.fields.staleLevel = null;
  },
  requirements: {
    State: {
      type: entities.State.fieldType
    },
    staleLevel: {
      type: entities.EnumField.fieldType,
      name : "stale level",
      check: {name: '✅'},
    }
  }
});