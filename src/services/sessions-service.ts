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

      const rangeStart = new Date(params.startDate + 'T00:00:00Z');
      const rangeEnd = new Date(params.endDate + 'T23:59:59Z');

      if (isNaN(rangeStart.getTime()) || isNaN(rangeEnd.getTime())) {
        return error(400, 'Invalid date format. Use YYYY-MM-DD');
      }

      // Limit to 90 days
      const rangeDays = (rangeEnd.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24);
      if (rangeDays > 90) {
        return error(400, 'Date range too large. Maximum 90 days');
      }

      // 1. Fetch schedules
      const schedulesResult = await docClient.send(new QueryCommand({
        TableName: SCHEDULES_TABLE,
        KeyConditionExpression: 'tenantId = :tenantId',
        ExpressionAttributeValues: { ':tenantId': tenantId },
      }));
      
      let schedules = (schedulesResult.Items || []) as Schedule[];
      console.log(`[SessionsService] Found ${schedules.length} schedules`);

      // Filter by programId if specified
      if (params.programId) {
        schedules = schedules.filter(s => s.programId === params.programId);
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

      // 6. Apply additional filters
      let filtered = allSessions;
      if (params.type) {
        filtered = filtered.filter(s => s.type === params.type);
      }
      if (params.hostId) {
        filtered = filtered.filter(s => s.hosts?.some(h => h.id === params.hostId));
      }
      if (params.locationId) {
        filtered = filtered.filter(s => s.locationId === params.locationId);
      }

      // 7. Sort by start time
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
