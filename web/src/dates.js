// IREPS renders next_auction as "DD/MM/YYYY HH:MM:SS" (note: publish_date
// uses dashes instead of slashes, but we don't need to parse that one).
export function parseAuctionDate(value) {
  if (!value) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min, ss] = m;
  return new Date(+yyyy, +mm - 1, +dd, +hh, +min, +ss);
}

// Whole days from now until the auction (negative if already past).
export function daysToAuction(value) {
  const date = parseAuctionDate(value);
  if (!date) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  return Math.round((date - startOfToday) / msPerDay);
}

export function formatDaysTo(days) {
  if (days === null || days === undefined) return '';
  if (days < 0) return 'past';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days}d`;
}
