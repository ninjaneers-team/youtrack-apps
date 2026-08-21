const entities = require('@jetbrains/youtrack-scripting-api/entities');
const utils = require('./utils.js');
const search = require('@jetbrains/youtrack-scripting-api/search');

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
  cron: '0 0 * ? * MON-FRI',
  muteUpdateNotifications: true,
  search: (ctx) => {
    const issue = ctx.project.issues.first();
    return `issue id: ${issue.id}`;
  },
  action: (ctx) => {
    const settings = utils.getSettingsFromContext(ctx);
    const states = settings.states.map(state => '{' + state + '}').join(', ');
    const query = 'has: {Board ' + settings.board + '} State: ' + states + ' #Unresolved';
    const issues = search.search(ctx.project, query, ctx.currentUser);

    issues.forEach((issue) => {
      const currentStaleLevel = issue.fields[ctx.staleLevel.name];
      const lastMovedTimestamp = issue.extensionProperties.lastMovedTimestamp;
      const now = Date.now();
      const overdueInterval = DAY_IN_MS * ctx.settings.levelIncreaseIntervalInDays;

      // Updates timestamp and level if setting changes and issue isn’t moved yet.
      if(lastMovedTimestamp == null) {
        issue.extensionProperties.lastMovedTimestamp = now;
        issue.fields[ctx.staleLevel.name] = ctx.staleLevel.check;
        console.log("Initialized stale level tracking for issue " + issue.id);
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

      issue.fields[ctx.staleLevel.name] = nextStaleValue;
      console.log("Updated stale level for issue " + issue.id + " to " + nextStaleValue.name);
    });
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
      stale_max: {name: '🤯'},
    },
  }
});