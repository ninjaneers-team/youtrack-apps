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


exports.countWeekendDaysSince = countWeekendDaysSince;