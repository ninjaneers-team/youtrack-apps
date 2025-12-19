/**
 * Returns the number of weekend days (Saturday & Sunday)
 * between a given timestamp (ms) and now.
 * 
 * @param {number} pastTimestamp - A timestamp in milliseconds (Number).
 * @returns {number} count of weekend days
 */
function countWeekendDaysSince(pastTimestamp) {
  const start = new Date(pastTimestamp);
  const end = new Date();
  
  let daysCount = 0;
  
  while(start <= end) {
    const day = start.getDay();
    if(day == 0 || day == 6) {
      daysCount++;
    }
     start.setDate(start.getDate() + 1);
  }
  
  return daysCount;
}

function parseSettings(settingsStr) {
    return JSON.parse(settingsStr);
}

function createFilterQuery(settingsStr) {
    const settings = parseSettings(settingsStr)

    var result = 'has: {Board ' + settings.board + '}';
    for (var state in settings.states) {
        result += ' #{' + settings.states[state] + "} |";
    }
    return result.substring(0, result.length - 1);
}

function getSettingsFromContext(context) {

    if (context.globalStorage.extensionProperties.stalecardBoardName === null) {
        const parsedSettings = parseSettings(context.staleCardSettings);
        context.globalStorage.extensionProperties.stalecardBoardName = parsedSettings.board;
        context.globalStorage.extensionProperties.stalecardBoardStates = parsedSettings.states;
    }
    return {
        "board": context.globalStorage.extensionProperties.stalecardBoardName,
        "states": context.globalStorage.extensionProperties.stalecardBoardStates
    };
}

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


exports.countWeekendDaysSince = countWeekendDaysSince;
exports.createFilterQuery = createFilterQuery;
exports.getSettingsFromContext = getSettingsFromContext;
exports.isOnBoard = isOnBoard;
exports.checkState = checkState;