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

function getSettingsFromContext(context) {
    if (context.globalStorage.extensionProperties.stalecardBoardName === null) {
        const parsedSettings = JSON.parse(context.settings.staleCardSettings);
        context.globalStorage.extensionProperties.stalecardBoardName = parsedSettings.board;
        context.globalStorage.extensionProperties.stalecardBoardStates = parsedSettings.states;
    }
    return {
        "board": context.globalStorage.extensionProperties.stalecardBoardName,
        "states": context.globalStorage.extensionProperties.stalecardBoardStates
    };
}

function isOnBoard(boards, board) {
    let onBoard = false;

    boards.forEach(b => {
        if(b.name === board) {
            onBoard =  true;
        }
    });
    return onBoard;
}

function isStateTracked(states, issue) {
    return states.includes(issue.fields.State.name);
}

exports.countWeekendDaysSince = countWeekendDaysSince;
exports.getSettingsFromContext = getSettingsFromContext;
exports.isOnBoard = isOnBoard;
exports.isStateTracked = isStateTracked;