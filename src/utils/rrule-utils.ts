/**
 * RRULE Utilities for Session Generation
 * 
 * Uses the rrule library to expand recurring schedules into individual sessions.
 * Supports RFC5545 RRULE with constraints for MVP:
 * - FREQ: DAILY, WEEKLY, MONTHLY only
 * - WEEKLY: BYDAY required (e.g., MO,WE,FR)
 * - MONTHLY: Simple BYMONTHDAY only (e.g., 1st, 15th)
 * - No YEARLY, no complex BYSETPOS
 */

import { RRule, RRuleSet, rrulestr } from 'rrule';
import { Schedule, ScheduleException, Session, SessionSummary } from '../domain/models';

/**
 * Options for generating sessions from a schedule
 */
export interface GenerateSessionsOptions {
  /** Start of the date range (inclusive) */
  rangeStart: Date;
  /** End of the date range (inclusive) */
  rangeEnd: Date;
  /** Schedule exceptions to apply (cancellations/overrides) */
  exceptions?: ScheduleException[];
  /** Session summaries for capacity info */
  summaries?: Map<string, SessionSummary>;
}

/**
 * Generate session ID from schedule ID and date
 */
export function generateSessionId(scheduleId: string, date: string): string {
  return `${scheduleId}#${date}`;
}

/**
 * Parse session ID back to schedule ID and date
 */
export function parseSessionId(sessionId: string): { scheduleId: string; date: string } {
  const [scheduleId, date] = sessionId.split('#');
  return { scheduleId, date };
}

/**
 * Format date to YYYY-MM-DD in a given timezone
 */
export function formatDateLocal(date: Date, timezone: string): string {
  return date.toLocaleDateString('en-CA', { timeZone: timezone }); // en-CA gives YYYY-MM-DD
}

/**
 * Get duration in minutes between two ISO datetime strings
 */
export function getDurationMinutes(start: string, end: string): number {
  const startDate = new Date(start);
  const endDate = new Date(end);
  return Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60));
}

/**
 * Extract local time components from a datetime string
 * Returns the time portion as-is, stripping any timezone info
 * 
 * Examples:
 * - "2025-12-11T19:00:00-05:00" → { hours: 19, minutes: 0, seconds: 0 }
 * - "2025-12-11T09:30:00" → { hours: 9, minutes: 30, seconds: 0 }
 * - "2025-12-11T14:00:00Z" → { hours: 14, minutes: 0, seconds: 0 }
 */
function extractLocalTimeComponents(dateTimeStr: string): { hours: number; minutes: number; seconds: number } {
  // Match the time portion: HH:MM:SS (ignoring timezone suffix)
  const timeMatch = dateTimeStr.match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (!timeMatch) {
    return { hours: 0, minutes: 0, seconds: 0 };
  }
  return {
    hours: parseInt(timeMatch[1], 10),
    minutes: parseInt(timeMatch[2], 10),
    seconds: parseInt(timeMatch[3], 10),
  };
}

/**
 * Extract local date components from a datetime string
 * Returns the date portion as-is, stripping any timezone info
 */
function extractLocalDateComponents(dateTimeStr: string): { year: number; month: number; day: number } {
  // Match the date portion: YYYY-MM-DD
  const dateMatch = dateTimeStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!dateMatch) {
    return { year: 2025, month: 1, day: 1 };
  }
  return {
    year: parseInt(dateMatch[1], 10),
    month: parseInt(dateMatch[2], 10),
    day: parseInt(dateMatch[3], 10),
  };
}

/**
 * Convert a UTC Date to "naive local" Date in a specific timezone
 * The returned Date has UTC values that match the local wall-clock time
 * 
 * Example: convertUtcToNaiveLocal(Dec 12 05:00Z, "America/New_York")
 *          → Dec 12 00:00Z (because 05:00 UTC = 00:00 EST, we want the "00:00" part as UTC)
 */
function convertUtcToNaiveLocal(utcDate: Date, timezone: string): Date {
  // Format the UTC date in the target timezone to get local components
  const localString = utcDate.toLocaleString('en-US', { 
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  
  // Parse: "12/11/2025, 19:00:00" → create a Date treating these as UTC values
  const [datePart, timePart] = localString.split(', ');
  const [month, day, year] = datePart.split('/').map(Number);
  const [hours, minutes, seconds] = timePart.split(':').map(Number);
  
  return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
}

/**
 * Convert a "naive local" Date back to actual UTC in a specific timezone
 * The input Date has UTC values that represent local wall-clock time
 * 
 * Example: convertNaiveLocalToUtc(Dec 11 19:00Z, "America/New_York")
 *          → Dec 12 00:00Z (because 19:00 local EST = 00:00 UTC next day)
 */
function convertNaiveLocalToUtc(naiveDate: Date, timezone: string): Date {
  // Extract the "local" time from the naive date's UTC values
  const year = naiveDate.getUTCFullYear();
  const month = naiveDate.getUTCMonth();
  const day = naiveDate.getUTCDate();
  const hours = naiveDate.getUTCHours();
  const minutes = naiveDate.getUTCMinutes();
  const seconds = naiveDate.getUTCSeconds();
  
  // Create an ISO string representing this local time (without timezone)
  const localIso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  
  // Use parseLocalDateTime to convert to actual UTC
  return parseLocalDateTime(localIso, timezone);
}

/**
 * Parse a local datetime string in a specific timezone and return UTC Date
 * 
 * Example: parseLocalDateTime("2025-12-07T09:00:00", "America/New_York")
 * Returns: Date representing 2025-12-07T14:00:00Z (9am EST = 2pm UTC)
 * 
 * Handles multiple formats:
 * - "2025-12-07T09:00:00" (local datetime, needs timezone context)
 * - "2025-12-07T14:00:00Z" (already UTC)
 * - "2025-12-07T09:00:00-05:00" (ISO8601 with offset, already absolute)
 * 
 * @param localDateTime - ISO datetime string
 * @param timezone - IANA timezone, e.g. "America/New_York" (used only for naive datetimes)
 * @returns Date object representing the correct UTC moment
 */
export function parseLocalDateTime(localDateTime: string, timezone: string): Date {
  // If already has Z suffix, it's already UTC - just parse directly
  if (localDateTime.endsWith('Z')) {
    return new Date(localDateTime);
  }

  // Check if the string already has a timezone offset (e.g., -05:00, +00:00)
  // ISO8601 offset format: ±HH:MM or ±HHMM at the end
  const offsetRegex = /[+-]\d{2}:?\d{2}$/;
  if (offsetRegex.test(localDateTime)) {
    // Already has offset info - parse directly (JavaScript handles this correctly)
    return new Date(localDateTime);
  }

  // No timezone info - treat as local datetime in the specified timezone
  // Parse as UTC temporarily to extract the date/time values
  const asUtc = new Date(localDateTime + 'Z');
  
  // Format this UTC moment in both UTC and target timezone
  const utcString = asUtc.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzString = asUtc.toLocaleString('en-US', { timeZone: timezone });
  
  // Calculate offset (how much to add to convert from timezone to UTC)
  const offsetMs = new Date(utcString).getTime() - new Date(tzString).getTime();
  
  // Apply offset: we want "9am in timezone" → correct UTC
  return new Date(asUtc.getTime() + offsetMs);
}

/**
 * Generate sessions from a schedule within a date range
 * 
 * For non-recurring schedules, returns a single session if within range.
 * For recurring schedules, expands the RRULE and generates sessions.
 * 
 * IMPORTANT: RRULE expansion happens in "naive local time" context to ensure
 * that BYDAY (Mon, Tue, etc.) matches the user's local timezone weekdays,
 * not UTC weekdays. This is critical for evening sessions that cross the
 * UTC day boundary (e.g., 7PM EST = midnight UTC next day).
 * 
 * @param schedule - The schedule to generate sessions from
 * @param options - Generation options (date range, exceptions, summaries)
 * @returns Array of Session objects
 */
export function generateSessions(
  schedule: Schedule,
  options: GenerateSessionsOptions
): Session[] {
  const { rangeStart, rangeEnd, exceptions = [], summaries } = options;
  const sessions: Session[] = [];

  // Build exception map for quick lookup
  const exceptionMap = new Map<string, ScheduleException>();
  for (const exc of exceptions) {
    exceptionMap.set(exc.occurrenceDate, exc);
  }

  // Extract local time components from schedule (the wall-clock time in user's timezone)
  const localTimeComponents = extractLocalTimeComponents(schedule.start);
  const localDateComponents = extractLocalDateComponents(schedule.start);
  
  // Calculate duration from the original schedule times
  const startDateUtc = parseLocalDateTime(schedule.start, schedule.timezone);
  const endDateUtc = parseLocalDateTime(schedule.end, schedule.timezone);
  const durationMs = endDateUtc.getTime() - startDateUtc.getTime();

  // For RRULE expansion, we need to work in "naive local time" context
  // This ensures BYDAY matches local weekdays, not UTC weekdays
  
  // Create naive dtstart: the local date/time treated as if it were UTC
  const naiveDtstart = new Date(Date.UTC(
    localDateComponents.year,
    localDateComponents.month - 1,
    localDateComponents.day,
    localTimeComponents.hours,
    localTimeComponents.minutes,
    localTimeComponents.seconds
  ));

  // Convert query range to naive local time in the schedule's timezone
  const naiveRangeStart = convertUtcToNaiveLocal(rangeStart, schedule.timezone);
  const naiveRangeEnd = convertUtcToNaiveLocal(rangeEnd, schedule.timezone);

  let naiveOccurrences: Date[] = [];

  if (!schedule.isRecurring || !schedule.rrule) {
    // Non-recurring: check if the single occurrence is in range
    // For non-recurring, compare the actual UTC times
    if (startDateUtc >= rangeStart && startDateUtc <= rangeEnd) {
      // Return the naive occurrence for consistent processing below
      naiveOccurrences = [naiveDtstart];
    }
  } else {
    // Recurring: expand RRULE in naive local time context
    try {
      const rule = rrulestr(schedule.rrule, { dtstart: naiveDtstart });
      naiveOccurrences = rule.between(naiveRangeStart, naiveRangeEnd, true);
    } catch (error) {
      console.error(`[rrule-utils] Failed to parse RRULE for schedule ${schedule.scheduleId}:`, error);
      return sessions;
    }
  }

  // Generate sessions for each occurrence
  for (const naiveOccurrence of naiveOccurrences) {
    // The naive occurrence has the correct local date/time as UTC values
    // Extract the local date string directly from the naive occurrence
    const year = naiveOccurrence.getUTCFullYear();
    const month = String(naiveOccurrence.getUTCMonth() + 1).padStart(2, '0');
    const day = String(naiveOccurrence.getUTCDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    
    const exception = exceptionMap.get(dateStr);

    // Skip cancelled sessions
    if (exception?.type === 'CANCELLED') {
      continue;
    }

    // Calculate session times by converting naive local back to actual UTC
    let sessionStart: Date;
    let sessionEnd: Date;
    let sessionHosts = schedule.hosts;
    let sessionLocationId = schedule.locationId;
    let sessionCapacity = schedule.baseCapacity;

    if (exception?.type === 'OVERRIDE') {
      // Apply overrides (parse override times in schedule's timezone)
      sessionStart = exception.overrideStart 
        ? parseLocalDateTime(exception.overrideStart, schedule.timezone)
        : convertNaiveLocalToUtc(naiveOccurrence, schedule.timezone);
      sessionEnd = exception.overrideEnd
        ? parseLocalDateTime(exception.overrideEnd, schedule.timezone)
        : new Date(sessionStart.getTime() + durationMs);
      sessionHosts = exception.overrideHosts || sessionHosts;
      sessionLocationId = exception.overrideLocationId || sessionLocationId;
      sessionCapacity = exception.overrideCapacity ?? sessionCapacity;
    } else {
      // Normal occurrence - convert naive local to actual UTC
      sessionStart = convertNaiveLocalToUtc(naiveOccurrence, schedule.timezone);
      sessionEnd = new Date(sessionStart.getTime() + durationMs);
    }

    const sessionId = generateSessionId(schedule.scheduleId, dateStr);
    
    // Get summary data if available
    const summary = summaries?.get(sessionId);

    const session: Session = {
      tenantId: schedule.tenantId,
      sessionId,
      scheduleId: schedule.scheduleId,
      programId: schedule.programId,
      type: schedule.type,
      date: dateStr,
      start: sessionStart.toISOString(),
      end: sessionEnd.toISOString(),
      timezone: schedule.timezone,
      hosts: sessionHosts,
      locationId: sessionLocationId,
      tags: schedule.tags,
      capacity: sessionCapacity,
      bookedCount: summary?.bookedCount ?? 0,
      waitlistCount: summary?.waitlistCount ?? 0,
    };

    sessions.push(session);
  }

  return sessions;
}

/**
 * Validate an RRULE string against MVP constraints
 * 
 * @param rruleStr - The RRULE string to validate
 * @returns { valid: boolean; error?: string }
 */
export function validateRRule(rruleStr: string): { valid: boolean; error?: string } {
  try {
    const rule = rrulestr(rruleStr);
    const options = rule.origOptions;

    // Check frequency
    const allowedFreqs = [RRule.DAILY, RRule.WEEKLY, RRule.MONTHLY];
    if (!allowedFreqs.includes(options.freq!)) {
      return { 
        valid: false, 
        error: 'Only DAILY, WEEKLY, and MONTHLY frequencies are supported' 
      };
    }

    // WEEKLY requires BYDAY
    if (options.freq === RRule.WEEKLY && !options.byweekday) {
      return { 
        valid: false, 
        error: 'WEEKLY frequency requires BYDAY (e.g., MO,WE,FR)' 
      };
    }

    // MONTHLY: only simple BYMONTHDAY supported
    if (options.freq === RRule.MONTHLY) {
      if (options.bysetpos || options.bynweekday) {
        return { 
          valid: false, 
          error: 'Complex MONTHLY rules (BYSETPOS, nth weekday) are not supported. Use simple BYMONTHDAY.' 
        };
      }
    }

    return { valid: true };
  } catch (error: any) {
    return { valid: false, error: `Invalid RRULE: ${error.message}` };
  }
}

/**
 * Create an RRULE string from common parameters
 */
export function createRRule(params: {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval?: number;
  byweekday?: ('MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU')[];
  bymonthday?: number[];
  until?: Date;
  count?: number;
}): string {
  const parts: string[] = [`FREQ=${params.freq}`];

  if (params.interval && params.interval > 1) {
    parts.push(`INTERVAL=${params.interval}`);
  }

  if (params.byweekday?.length) {
    parts.push(`BYDAY=${params.byweekday.join(',')}`);
  }

  if (params.bymonthday?.length) {
    parts.push(`BYMONTHDAY=${params.bymonthday.join(',')}`);
  }

  if (params.until) {
    const untilStr = params.until.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    parts.push(`UNTIL=${untilStr}`);
  }

  if (params.count) {
    parts.push(`COUNT=${params.count}`);
  }

  return `RRULE:${parts.join(';')}`;
}

/**
 * Get the next occurrence of a schedule after a given date
 * Uses timezone-aware RRULE expansion
 */
export function getNextOccurrence(schedule: Schedule, after: Date = new Date()): Date | null {
  if (!schedule.isRecurring || !schedule.rrule) {
    const startDate = parseLocalDateTime(schedule.start, schedule.timezone);
    return startDate > after ? startDate : null;
  }

  try {
    // Extract local time/date components for naive expansion
    const localTimeComponents = extractLocalTimeComponents(schedule.start);
    const localDateComponents = extractLocalDateComponents(schedule.start);
    
    const naiveDtstart = new Date(Date.UTC(
      localDateComponents.year,
      localDateComponents.month - 1,
      localDateComponents.day,
      localTimeComponents.hours,
      localTimeComponents.minutes,
      localTimeComponents.seconds
    ));
    
    // Convert "after" to naive local time
    const naiveAfter = convertUtcToNaiveLocal(after, schedule.timezone);
    
    const rule = rrulestr(schedule.rrule, { dtstart: naiveDtstart });
    const naiveNext = rule.after(naiveAfter, false);
    
    if (!naiveNext) return null;
    
    // Convert back to actual UTC
    return convertNaiveLocalToUtc(naiveNext, schedule.timezone);
  } catch {
    return null;
  }
}


