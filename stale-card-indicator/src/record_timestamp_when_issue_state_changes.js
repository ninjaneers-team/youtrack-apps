const entities = require('@jetbrains/youtrack-scripting-api/entities');

exports.rule = entities.Issue.onChange({
  title: 'Record_timestamp_when_issue_state_is_changed',
  guard: (ctx) => {
    const issue = ctx.issue;
    return (issue.isReported && issue.fields.isChanged(ctx.State)) || (issue.becomesReported && issue.fields.State != null);
  },
  action: (ctx) => {
    ctx.issue.extensionProperties.lastMovedTimestamp = Date.now();
    ctx.issue.fields.staleLevel = ctx.staleLevel.check;
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