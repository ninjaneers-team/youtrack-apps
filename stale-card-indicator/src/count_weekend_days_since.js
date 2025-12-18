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

    var result = 'has: Board' + settings.board;
    for (var state in settings.states) {
        result += ' #' + state + "|";
    }
    return result.substring(0, result.length - 1);
}

exports.countWeekendDaysSince = countWeekendDaysSince;
exports.createFilterQuery = createFilterQuery;