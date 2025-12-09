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
 * Apply time from source date to target date
 */
function applyTimeToDate(targetDate: Date, sourceDateTime: Date): Date {
  const result = new Date(targetDate);
  result.setHours(sourceDateTime.getHours());
  result.setMinutes(sourceDateTime.getMinutes());
  result.setSeconds(sourceDateTime.getSeconds());
  result.setMilliseconds(sourceDateTime.getMilliseconds());
  return result;
}

/**
 * Generate sessions from a schedule within a date range
 * 
 * For non-recurring schedules, returns a single session if within range.
 * For recurring schedules, expands the RRULE and generates sessions.
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

  // Calculate duration for applying to each occurrence
  const startDate = new Date(schedule.start);
  const endDate = new Date(schedule.end);
  const durationMs = endDate.getTime() - startDate.getTime();

  let occurrenceDates: Date[] = [];

  if (!schedule.isRecurring || !schedule.rrule) {
    // Non-recurring: just check if the single date is in range
    if (startDate >= rangeStart && startDate <= rangeEnd) {
      occurrenceDates = [startDate];
    }
  } else {
    // Recurring: expand RRULE
    try {
      const rule = rrulestr(schedule.rrule, { dtstart: startDate });
      occurrenceDates = rule.between(rangeStart, rangeEnd, true);
    } catch (error) {
      console.error(`[rrule-utils] Failed to parse RRULE for schedule ${schedule.scheduleId}:`, error);
      return sessions;
    }
  }

  // Generate sessions for each occurrence
  for (const occurrenceDate of occurrenceDates) {
    const dateStr = formatDateLocal(occurrenceDate, schedule.timezone);
    const exception = exceptionMap.get(dateStr);

    // Skip cancelled sessions
    if (exception?.type === 'CANCELLED') {
      continue;
    }

    // Calculate session times
    let sessionStart: Date;
    let sessionEnd: Date;
    let sessionHosts = schedule.hosts;
    let sessionLocationId = schedule.locationId;
    let sessionCapacity = schedule.baseCapacity;

    if (exception?.type === 'OVERRIDE') {
      // Apply overrides
      sessionStart = exception.overrideStart 
        ? new Date(exception.overrideStart) 
        : applyTimeToDate(occurrenceDate, startDate);
      sessionEnd = exception.overrideEnd
        ? new Date(exception.overrideEnd)
        : new Date(sessionStart.getTime() + durationMs);
      sessionHosts = exception.overrideHosts || sessionHosts;
      sessionLocationId = exception.overrideLocationId || sessionLocationId;
      sessionCapacity = exception.overrideCapacity ?? sessionCapacity;
    } else {
      // Normal occurrence - apply original time to occurrence date
      sessionStart = applyTimeToDate(occurrenceDate, startDate);
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
 */
export function getNextOccurrence(schedule: Schedule, after: Date = new Date()): Date | null {
  if (!schedule.isRecurring || !schedule.rrule) {
    const startDate = new Date(schedule.start);
    return startDate > after ? startDate : null;
  }

  try {
    const rule = rrulestr(schedule.rrule, { dtstart: new Date(schedule.start) });
    return rule.after(after, false);
  } catch {
    return null;
  }
}


