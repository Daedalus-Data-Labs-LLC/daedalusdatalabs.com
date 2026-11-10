// Reads reminder times from plain English, in the person's own timezone.
// No AI involved, so reminders cost nothing.
//
//   in 20 minutes · in 2 hours · in 3 days · in a week
//   tomorrow · tomorrow 9am · tomorrow at 14:30
//   friday · next monday 10am · on tue at 3pm
//   at 5pm · at 17:00 · tonight · noon        (today, or tomorrow if already past)
//   2026-11-20 · 2026-11-20 9:30 · 11/20 · 11/20 at 4pm
//
// A day without a time means 9am. An hour from 1 to 7 without am/pm means pm
// ("at 3" is almost always 3pm).

const TIME = String.raw`(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)`;
const AT = String.raw`(?:\s*,?\s*(?:at\s+)?${TIME})?`;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY = String.raw`(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?`;
const UNITS = { m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, d: 1440, day: 1440, days: 1440, w: 10080, week: 10080, weeks: 10080 };

const PATTERNS = [
  ["date", new RegExp(String.raw`\b(?:on\s+)?(\d{4})-(\d{1,2})-(\d{1,2})${AT}\b`, "i")],
  ["slash", new RegExp(String.raw`\b(?:on\s+)?(\d{1,2})\/(\d{1,2})${AT}(?=\s|$|[.,!])`, "i")],
  ["relative", /\bin\s+(\d+|an?|one)\s*(minutes?|mins?|m|hours?|hrs?|hr|h|days?|d|weeks?|w)\b/i],
  ["tomorrow", new RegExp(String.raw`\btomorrow${AT}\b`, "i")],
  ["weekday", new RegExp(String.raw`\b(?:on\s+|next\s+|this\s+)?${DAY}${AT}\b`, "i")],
  ["tonight", /\btonight\b/i],
  ["at", new RegExp(String.raw`\b(?:at\s+${TIME}|(noon|midnight))(?=\s|$|[.,!])`, "i")],
];

// Returns { dueAt, what } or { error }.
export function parseReminder(input, timeZone = "UTC", now = Date.now()) {
  const text = String(input).replace(/^\s*(?:please\s+)?remind\s+(?:me|us)\s*/i, "").trim();
  for (const [kind, re] of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const dueAt = resolve(kind, m, timeZone, now);
    if (dueAt == null) return { error: "I couldn't read that time. Try *in 2 hours*, *tomorrow 9am* or *friday at 3pm*." };
    const what = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length))
      .replace(/\s+/g, " ")
      .replace(/^\s*(?:to|that|about)\s+/i, "")
      .replace(/\s+(?:to|that|about)\s*$/i, "")
      .replace(/^[\s,.:;-]+|[\s,:;-]+$/g, "")
      .trim();
    if (!what) return { error: "What should I remind you about? For example: *remind me tomorrow 9am to review PR #24*." };
    if (dueAt <= now) return { error: "That time has already passed." };
    if (dueAt > now + 366 * 86_400_000) return { error: "I can only set reminders up to a year ahead." };
    return { dueAt, what };
  }
  return { error: "I couldn't find a time. Try *in 2 hours*, *tomorrow 9am* or *friday at 3pm*." };
}

function resolve(kind, m, tz, now) {
  const today = zonedParts(now, tz);
  switch (kind) {
    case "relative": {
      const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
      return now + n * UNITS[m[2].toLowerCase()] * 60_000;
    }
    case "tonight":
      return local(today, { h: 20, mi: 0 }, tz);
    case "at": {
      const t = parseTime(m[1] ?? m[2]);
      if (!t) return null;
      const due = local(today, t, tz);
      return due > now ? due : local(addDays(today, 1), t, tz);
    }
    case "tomorrow":
      return local(addDays(today, 1), parseTime(m[1]) ?? { h: 9, mi: 0 }, tz);
    case "weekday": {
      const target = DAYS.findIndex((d) => d.startsWith(m[1].toLowerCase().slice(0, 3)));
      const t = parseTime(m[2]) ?? { h: 9, mi: 0 };
      let ahead = (target - weekday(today) + 7) % 7;
      if (ahead === 0 && local(today, t, tz) <= now) ahead = 7;
      if (/^\s*next\s/i.test(m[0]) && ahead === 0) ahead = 7;
      return local(addDays(today, ahead), t, tz);
    }
    case "date": {
      const t = parseTime(m[4]) ?? { h: 9, mi: 0 };
      return valid(+m[2], +m[3]) ? local({ y: +m[1], mo: +m[2], d: +m[3] }, t, tz) : null;
    }
    case "slash": {
      const t = parseTime(m[3]) ?? { h: 9, mi: 0 };
      if (!valid(+m[1], +m[2])) return null;
      let due = local({ y: today.y, mo: +m[1], d: +m[2] }, t, tz);
      if (due <= now) due = local({ y: today.y + 1, mo: +m[1], d: +m[2] }, t, tz);
      return due;
    }
  }
  return null;
}

const valid = (mo, d) => mo >= 1 && mo <= 12 && d >= 1 && d <= 31;

export function parseTime(s) {
  if (!s) return null;
  const t = s.toLowerCase().replace(/\./g, "").trim();
  if (t === "noon") return { h: 12, mi: 0 };
  if (t === "midnight") return { h: 0, mi: 0 };
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  if (h > 23 || mi > 59) return null;
  if (m[3] === "pm" && h < 12) h += 12;
  else if (m[3] === "am" && h === 12) h = 0;
  else if (!m[3] && h >= 1 && h <= 7) h += 12;
  return { h, mi };
}

// ---------- timezone arithmetic ----------

export function zonedParts(ms, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour % 24, mi: +parts.minute };
}

// A wall-clock time in a timezone, as a UTC timestamp (handles daylight saving).
export function local({ y, mo, d }, { h, mi }, timeZone) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, timeZone);
    guess = wall - (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - guess);
  }
  return guess;
}

function addDays({ y, mo, d }, n) {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const weekday = ({ y, mo, d }) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();

export function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
