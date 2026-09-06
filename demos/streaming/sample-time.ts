/** Date the canned transcript in local calendar days, ending yesterday. */
export function sampleTimestamp(
  index: number,
  lastIndex: number,
  now = Date.now(),
): number {
  const messagesPerDay = 8;
  const daysBack =
    1 +
    Math.floor(lastIndex / messagesPerDay) -
    Math.floor(index / messagesPerDay);
  const date = new Date(now);
  // Calendar arithmetic keeps "yesterday" correct across daylight-saving
  // changes; subtracting a fixed 24 hours near midnight does not.
  date.setDate(date.getDate() - daysBack);
  date.setHours(12, (index % messagesPerDay) * 2, 0, 0);
  return date.getTime();
}
