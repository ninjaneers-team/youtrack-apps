const entities = require('@jetbrains/youtrack-scripting-api/entities');
const count = require('./utils.js');
const {getSettingsFromContext} = require("./utils.js");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const OVERDUE_INTERVALL =  (DAY_IN_MS * 2).toFixed(7);

function isOnBoard(boards, board) {
    return  boards.some(boardItem => {
        if (boardItem.name === board) {
            return true;
        }
    });
}

function checkState(states, issue) {
    return  states.some(state => {
        if (state === issue.fields().State()) {
            return true;
        }
    });
}

exports.rule = entities.Issue.onSchedule({
  title: 'check every hour if issue is overdue',
  search: 'has:boards #Unresolved',
  cron: '0 0 * * * ?',
  guard: (ctx) => {
    const settings = getSettingsFromContext(ctx)
    const issue = ctx.issue;

    return !isOnBoard(issue.boards(), settings.board) && !checkState(settings.states, issue);
  },
  action: (ctx) => {
    const issue = ctx.issue;
    const currentStaleLevel = issue.fields.staleLevel;
    const lastMovedTimestamp = issue.extensionProperties.lastMovedTimestamp;
    const now = new Date();
    
    const numberOfWeekendDays = count.countWeekendDaysSince(lastMovedTimestamp);
    const staleDuration = now - lastMovedTimestamp - (numberOfWeekendDays * DAY_IN_MS);
    const newStaleLevelNum = Math.floor(staleDuration / OVERDUE_INTERVALL);
    
    if (
      newStaleLevelNum < 0 ||
      newStaleLevelNum === currentStaleLevel.ordinal - 1 ||
      newStaleLevelNum > ctx.staleLevel.values.size - 1
    ) {
      return;
    }
    
    const nextStaleValue = ctx.staleLevel.findValueByOrdinal(
      newStaleLevelNum + 1
    );
    
    ctx.issue.fields.staleLevel = nextStaleValue;
  },
  requirements: {
    staleLevel: {
      type: entities.EnumField.fieldType,
      name : "stale level",
      check: {name: '✅'}, 
      one_dot: {name: '🟢'},
      two_dots: {name: '🟢🟢'},
      three_dots: {name: '🟢🟢🟢'},
      four_dots: {name: '🟡🟡🟡🟡'},
      five_dots: {name: '🟡🟡🟡🟡🟡'},
      six_dots: {name: '🟠🟠🟠🟠🟠🟠'},
      seven_dots: {name: '🔴🔴🔴🔴🔴🔴🔴'},
      head_explodes: {name: '🤯'},
    },
   State: {
        type: entities.State.fieldType
   }
  }
});