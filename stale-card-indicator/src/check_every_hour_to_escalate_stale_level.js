const entities = require('@jetbrains/youtrack-scripting-api/entities');
const utils = require('./utils.js');

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const STALE_LEVEL_MAP = {
  0: '✅',
  1: '🟢',
  2: '🟢🟢',
  3: '🟢🟢🟢',
  4: '🟡🟡🟡🟡',
  5: '🟡🟡🟡🟡🟡',
  6: '🟠🟠🟠🟠🟠🟠',
  7: '🔴🔴🔴🔴🔴🔴🔴',
  8: '🤯'
};

exports.rule = entities.Issue.onSchedule({
  title: 'Check every hour to escalate the stale level',
  search: 'has:boards #Unresolved',
  cron: '0 0 * * * ?',
  guard: (ctx) => {
    const issue = ctx.issue;
    const settings = utils.getSettingsFromContext(ctx);

    return utils.isOnBoard(issue.boards, settings.board) && settings.states.includes(issue.fields.State.name);
  },
  action: (ctx) => {
    const issue = ctx.issue;
    const currentStaleLevel = issue.fields.staleLevel;
    const lastMovedTimestamp = issue.extensionProperties.lastMovedTimestamp;
    const now = Date.now();
    const overdueInterval = DAY_IN_MS * ctx.settings.levelIncreaseIntervalInDays;

    // Updates timestamp and level if setting changes and issue isn’t moved yet.
    if(lastMovedTimestamp == null) {
      issue.extensionProperties.lastMovedTimestamp = now;
      issue.fields.staleLevel = ctx.staleLevel.check;
      return;
    }

    const holidayDatesSet = utils.getHolidayDatesSetFromContext(ctx);
    const numberOfWeekendDaysAndHolidays = utils.countWeekendDaysAndHolidaysSince(lastMovedTimestamp,  holidayDatesSet);
    const staleDuration = Math.max(0, now - lastMovedTimestamp - (numberOfWeekendDaysAndHolidays * DAY_IN_MS));
    const newStaleLevelNum = Math.floor(staleDuration / overdueInterval);

    if (!(newStaleLevelNum in STALE_LEVEL_MAP) || STALE_LEVEL_MAP[newStaleLevelNum] === currentStaleLevel.name ) {
      return;
    }

    const nextStaleValue = ctx.staleLevel.findValueByName(
        STALE_LEVEL_MAP[newStaleLevelNum]
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
  }
});