/**
 * Sessions Service
 * 
 * READ-ONLY service for computed Sessions.
 * Sessions are virtual entities generated from Schedules + Exceptions.
 * 
 * API Base Path: /scheduling/sessions
 */

import { ApiBasePath, ApiMethod } from '@toldyaonce/kx-cdk-lambda-utils';
import { getApiMethodHandlers } from '@toldyaonce/kx-cdk-lambda-utils/wrappers/rest-service';
import { Session, Schedule, ScheduleException, SessionSummary } from '../domain/models';
import { generateSessions, parseSessionId } from '../utils/rrule-utils';
import { 
  docClient, 
  success, 
  error, 
  getTenantId,
  QueryCommand,
  GetCommand,
  BatchGetCommand
} from './base-service';

const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE!;
const EXCEPTIONS_TABLE = process.env.SCHEDULE_EXCEPTIONS_TABLE!;
const SUMMARIES_TABLE = process.env.SESSION_SUMMARIES_TABLE!;

/**
 * Sessions Service (read-only)
 */
@ApiBasePath('/scheduling/sessions')
export class SessionsService {

  /**
   * List sessions within a date range
   * GET /scheduling/sessions?tenantId=xxx&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
   */
  @ApiMethod('GET')
  async get(event: any) {
    console.log('[SessionsService] GET - Generating sessions');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    const params = event.queryStringParameters || {};
    const sessionId = params.sessionId;

    try {
      // If sessionId provided, get single session
      if (sessionId) {
        return await this.getSingleSession(tenantId, sessionId);
      }

      // Otherwise, list sessions in date range
      if (!params.startDate || !params.endDate) {
        return error(400, 'Missing required params: startDate and endDate (YYYY-MM-DD)');
      }

      // Validate date format first
      const testStart = new Date(params.startDate + 'T00:00:00Z');
      const testEnd = new Date(params.endDate + 'T23:59:59Z');

      if (isNaN(testStart.getTime()) || isNaN(testEnd.getTime())) {
        return error(400, 'Invalid date format. Use YYYY-MM-DD');
      }

      // Limit to 90 days
      const rangeDays = (testEnd.getTime() - testStart.getTime()) / (1000 * 60 * 60 * 24);
      if (rangeDays > 90) {
        return error(400, 'Date range too large. Maximum 90 days');
      }

      // Extend range to cover all timezones (UTC-12 to UTC+14)
      // This ensures we capture sessions that occur on the requested dates in ANY timezone
      // We'll filter by actual local date after generation
      const rangeStart = new Date(params.startDate + 'T00:00:00Z');
      rangeStart.setUTCHours(rangeStart.getUTCHours() - 14); // Cover UTC+14
      
      const rangeEnd = new Date(params.endDate + 'T23:59:59Z');
      rangeEnd.setUTCHours(rangeEnd.getUTCHours() + 12); // Cover UTC-12

      // Store requested dates for filtering later
      const requestedStartDate = params.startDate;
      const requestedEndDate = params.endDate;

      // 1. Fetch schedules
      const schedulesResult = await docClient.send(new QueryCommand({
        TableName: SCHEDULES_TABLE,
        KeyConditionExpression: 'tenantId = :tenantId',
        ExpressionAttributeValues: { ':tenantId': tenantId },
      }));
      
      let schedules = (schedulesResult.Items || []) as Schedule[];
      console.log(`[SessionsService] Found ${schedules.length} schedules`);

      // Filter by programId(s) if specified
      // Supports both single programId and comma-delimited programIds
      if (params.programIds || params.programId) {
        const programIdList = params.programIds 
          ? params.programIds.split(',').map((id: string) => id.trim())
          : [params.programId];
        const programIdSet = new Set(programIdList);
        schedules = schedules.filter(s => s.programId && programIdSet.has(s.programId));
        console.log(`[SessionsService] Filtering by ${programIdSet.size} programId(s): ${schedules.length} schedules remain`);
      }

      // 2. Fetch exceptions for all schedules in range
      const allExceptions: ScheduleException[] = [];
      for (const schedule of schedules) {
        const excResult = await docClient.send(new QueryCommand({
          TableName: EXCEPTIONS_TABLE,
          KeyConditionExpression: 'pk = :pk AND occurrenceDate BETWEEN :start AND :end',
          ExpressionAttributeValues: {
            ':pk': `${tenantId}#${schedule.scheduleId}`,
            ':start': params.startDate,
            ':end': params.endDate,
          },
        }));
        if (excResult.Items) {
          allExceptions.push(...(excResult.Items as ScheduleException[]));
        }
      }
      console.log(`[SessionsService] Found ${allExceptions.length} exceptions`);

      // 3. Generate sessions
      const allSessions: Session[] = [];
      const sessionIds: string[] = [];

      for (const schedule of schedules) {
        const scheduleExceptions = allExceptions.filter(e => 
          (e as any).pk === `${tenantId}#${schedule.scheduleId}`
        );

        const sessions = generateSessions(schedule, {
          rangeStart,
          rangeEnd,
          exceptions: scheduleExceptions,
        });

        allSessions.push(...sessions);
        sessionIds.push(...sessions.map(s => s.sessionId));
      }

      // 4. Fetch summaries
      const summaries = await this.fetchSummaries(tenantId, sessionIds);

      // 5. Merge summary data
      for (const session of allSessions) {
        const summary = summaries.get(session.sessionId);
        if (summary) {
          session.bookedCount = summary.bookedCount;
          session.waitlistCount = summary.waitlistCount;
        }
      }

      // 6. Filter by actual local date (since we extended the UTC range for timezone safety)
      let filtered = allSessions.filter(session => {
        // session.date is already in YYYY-MM-DD format in the session's timezone
        return session.date >= requestedStartDate && session.date <= requestedEndDate;
      });
      console.log(`[SessionsService] After date filter (${requestedStartDate} to ${requestedEndDate}): ${filtered.length} sessions`);

      // 7. Apply additional filters
      if (params.type) {
        filtered = filtered.filter(s => s.type === params.type);
      }
      if (params.hostId) {
        filtered = filtered.filter(s => s.hosts?.some(h => h.id === params.hostId));
      }
      if (params.locationId) {
        filtered = filtered.filter(s => s.locationId === params.locationId);
      }

      // 7b. Apply time-of-day filter with timezone awareness
      // startTime/endTime are in HH:MM format, compared in the session's timezone
      if (params.startTime || params.endTime) {
        filtered = filtered.filter(session => {
          // Get the session's local time in its own timezone
          const sessionStart = new Date(session.start);
          const localTime = sessionStart.toLocaleTimeString('en-GB', {
            timeZone: session.timezone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          }); // Returns "HH:MM" format (e.g., "17:00")
          
          if (params.startTime && localTime < params.startTime) return false;
          if (params.endTime && localTime > params.endTime) return false;
          return true;
        });
        console.log(`[SessionsService] After time filter (${params.startTime}-${params.endTime}): ${filtered.length} sessions`);
      }

      // 8. Sort by start time
      filtered.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

      console.log(`[SessionsService] Returning ${filtered.length} sessions`);
      return success(filtered);
    } catch (err: any) {
      console.error('[SessionsService] GET error:', err);
      return error(500, err.message);
    }
  }

  private async getSingleSession(tenantId: string, sessionId: string) {
    try {
      const { scheduleId, date } = parseSessionId(sessionId);

      // Fetch schedule
      const scheduleResult = await docClient.send(new GetCommand({
        TableName: SCHEDULES_TABLE,
        Key: { tenantId, scheduleId },
      }));

      if (!scheduleResult.Item) {
        return error(404, 'Schedule not found');
      }

      const schedule = scheduleResult.Item as Schedule;

      // Fetch exception for this date
      const excResult = await docClient.send(new GetCommand({
        TableName: EXCEPTIONS_TABLE,
        Key: { pk: `${tenantId}#${scheduleId}`, occurrenceDate: date },
      }));

      const exceptions = excResult.Item ? [excResult.Item as ScheduleException] : [];

      // Generate session
      const targetDate = new Date(date + 'T00:00:00Z');
      const sessions = generateSessions(schedule, {
        rangeStart: targetDate,
        rangeEnd: new Date(targetDate.getTime() + 24 * 60 * 60 * 1000),
        exceptions,
      });

      const session = sessions.find(s => s.sessionId === sessionId);
      if (!session) {
        return error(404, 'Session not found (may be cancelled)');
      }

      // Fetch summary
      const summaryResult = await docClient.send(new GetCommand({
        TableName: SUMMARIES_TABLE,
        Key: { tenantId, sessionId },
      }));

      if (summaryResult.Item) {
        const summary = summaryResult.Item as SessionSummary;
        session.bookedCount = summary.bookedCount;
        session.waitlistCount = summary.waitlistCount;
      }

      return success(session);
    } catch (err: any) {
      console.error('[SessionsService] getSingleSession error:', err);
      return error(500, err.message);
    }
  }

  private async fetchSummaries(tenantId: string, sessionIds: string[]): Promise<Map<string, SessionSummary>> {
    const summaries = new Map<string, SessionSummary>();
    if (sessionIds.length === 0) return summaries;

    // Batch get in chunks of 100
    const chunkSize = 100;
    for (let i = 0; i < sessionIds.length; i += chunkSize) {
      const chunk = sessionIds.slice(i, i + chunkSize);
      const keys = chunk.map(sessionId => ({ tenantId, sessionId }));

      try {
        const result = await docClient.send(new BatchGetCommand({
          RequestItems: {
            [SUMMARIES_TABLE]: { Keys: keys },
          },
        }));

        const items = result.Responses?.[SUMMARIES_TABLE] || [];
        for (const item of items) {
          const summary = item as SessionSummary;
          summaries.set(summary.sessionId, summary);
        }
      } catch (err) {
        console.error('[SessionsService] fetchSummaries batch error:', err);
      }
    }

    return summaries;
  }
}

// Export individual handlers for Lambda (Sessions is read-only)
const service = new SessionsService();
export const get = (event: any) => service.get(event);
