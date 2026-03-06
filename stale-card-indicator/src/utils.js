/**
 * Returns the number of weekend days (Saturday & Sunday) and holidays
 * between a given timestamp (ms) and now.
 *
 * @param {number} pastTimestamp - A timestamp in milliseconds (Number).
 * @returns {number} count of weekend days and holidays
 */
function countWeekendDaysAndHolidaysSince(pastTimestamp, holidayDatesSet) {
    const start = new Date(pastTimestamp);
    const end = new Date();

    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);

    let daysCount = 0;

    while(start <= end) {
        const day = start.getDay();
        const isHoliday = holidayDatesSet?.has(start.toISOString().split('T')[0]) || false;

        if(day === 0 || day === 6 || isHoliday) {
            daysCount++;
        }
        start.setDate(start.getDate() + 1);
    }

    return daysCount;
}

function getSettingsFromContext(context) {
    return {
        "board": context.settings.trackedBoard.trim(),
        "states": context.settings.trackedStates.split(',').map(s => s.trim())
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

function getHolidayDatesSetFromContext(context){
    const holidayDates = JSON.parse(context.project.extensionProperties.holidaysByRegion);
    const holidayDatesSet = new Set();
    holidayDates.holidays.forEach(holiday => {
        holidayDatesSet.add(holiday.date);
    });
    return holidayDatesSet;
}

exports.countWeekendDaysAndHolidaysSince = countWeekendDaysAndHolidaysSince;
exports.getSettingsFromContext = getSettingsFromContext;
exports.isOnBoard = isOnBoard;
exports.getHolidayDatesExtensionFromContext = getHolidayDatesSetFromContext;