/**
 * Returns the number of weekend days (Saturday & Sunday) and holidays
 * between a given timestamp (ms) and now. Uses UTC for consistent results.
 *
 * @param {number} pastTimestamp - A timestamp in milliseconds (Number).
 * @param {Set<string>} holidayDatesSet - A Set of holiday dates in "YYYY-MM-DD" format (UTC-based).
 * @returns {number} count of weekend days and holidays
 */
function countWeekendDaysAndHolidaysSince(pastTimestamp, holidayDatesSet) {
    const start = new Date(pastTimestamp);
    const end = new Date();

    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(0, 0, 0, 0);

    let daysCount = 0;

    while(start <= end) {
        const day = start.getUTCDay();
        const dateStr = start.toISOString().split('T')[0];

        const isWeekend = day === 0 || day === 6;
        const isHoliday = holidayDatesSet.has(dateStr);

        if (isWeekend || isHoliday) {
            daysCount++;
        }
        start.setUTCDate(start.getUTCDate() + 1);
    }

    return daysCount;
}

function getSettingsFromContext(context) {
    return {
        "board": context.settings.trackedBoard.trim(),
        "states": context.settings.trackedStates
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
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

function getHolidayDatesSetFromContext(context) {
    const holidaysJsonString = context.project.extensionProperties?.holidaysByRegion;
    const holidaysSet = new Set();

    if (!holidaysJsonString) {return holidaysSet;}

    const holidaysByRegion = JSON.parse(holidaysJsonString);

    holidaysByRegion.holidays.forEach(holiday => {
        holidaysSet.add(holiday.date);
    });

    return holidaysSet;
}

exports.countWeekendDaysAndHolidaysSince = countWeekendDaysAndHolidaysSince;
exports.getSettingsFromContext = getSettingsFromContext;
exports.isOnBoard = isOnBoard;
exports.getHolidayDatesSetFromContext = getHolidayDatesSetFromContext;