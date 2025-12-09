/**
 * Attendance Service
 * 
 * Handles attendance recording with GPS-based check-in validation.
 * API Base Path: /scheduling/attendance
 */

import { ApiBasePath, ApiMethod } from '@toldyaonce/kx-cdk-lambda-utils';
import { getApiMethodHandlers } from '@toldyaonce/kx-cdk-lambda-utils/wrappers/rest-service';
import { AttendanceRecord, AttendanceStatus, CheckInMethod, Booking, Location, Schedule, ScheduleException, Session } from '../domain/models';
import { validateCheckIn, validateCheckInTime, DEFAULT_CHECK_IN_RADIUS_METERS } from '../utils/geo-utils';
import { parseSessionId, generateSessions } from '../utils/rrule-utils';
import { 
  docClient, 
  success, 
  error, 
  getTenantId, 
  getSubjectId,
  parseBody, 
  now,
  QueryCommand,
  GetCommand,
  PutCommand
} from './base-service';

const ATTENDANCE_TABLE = process.env.ATTENDANCE_TABLE!;
const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE!;
const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE!;
const EXCEPTIONS_TABLE = process.env.SCHEDULE_EXCEPTIONS_TABLE!;
const LOCATIONS_TABLE = process.env.LOCATIONS_TABLE!;

/**
 * Attendance Service
 */
@ApiBasePath('/scheduling/attendance')
export class AttendanceService {

  /**
   * GET /scheduling/attendance
   * - With sessionId: get attendance for session
   * - Without: get attendance history for current user
   */
  @ApiMethod('GET')
  async get(event: any) {
    console.log('[AttendanceService] GET - Fetching attendance');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    const params = event.queryStringParameters || {};

    try {
      if (params.sessionId) {
        // Attendance for a session
        const pk = `${tenantId}#${params.sessionId}`;
        const result = await docClient.send(new QueryCommand({
          TableName: ATTENDANCE_TABLE,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': pk },
        }));
        return success(result.Items || []);
      }

      // Attendance history for current user
      const subjectId = getSubjectId(event) || params.subjectId;
      if (!subjectId) {
        return error(400, 'Missing subjectId');
      }

      const result = await docClient.send(new QueryCommand({
        TableName: ATTENDANCE_TABLE,
        IndexName: 'bySubject',
        KeyConditionExpression: 'gsi1pk = :gsi1pk',
        ExpressionAttributeValues: { ':gsi1pk': `${tenantId}#${subjectId}` },
        ScanIndexForward: false,
        Limit: parseInt(params.limit) || 50,
      }));

      return success(result.Items || []);
    } catch (err: any) {
      console.error('[AttendanceService] GET error:', err);
      return error(500, err.message);
    }
  }

  /**
   * POST /scheduling/attendance
   * GPS check-in
   * Body: { bookingId, lat?, lng? }
   */
  @ApiMethod('POST')
  async create(event: any) {
    console.log('[AttendanceService] POST - Check-in');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    try {
      const body = parseBody(event);
      
      if (!body.bookingId) {
        return error(400, 'Missing bookingId');
      }

      // 1. Find booking
      const booking = await this.findBooking(tenantId, body.bookingId);
      if (!booking) {
        return error(404, 'Booking not found');
      }

      if (booking.status !== 'CONFIRMED') {
        return error(400, `Cannot check in - booking status is ${booking.status}`);
      }

      // Verify ownership
      const subjectId = getSubjectId(event);
      if (subjectId && booking.subjectId !== subjectId) {
        return error(403, 'Not authorized');
      }

      // 2. Check if already checked in
      const existing = await this.getAttendance(tenantId, booking.sessionId, body.bookingId);
      if (existing && existing.status === 'PRESENT') {
        return error(400, 'Already checked in');
      }

      // 3. Get session info
      const session = await this.getSessionInfo(tenantId, booking.sessionId);
      if (!session) {
        return error(404, 'Session not found');
      }

      // 4. Validate time window
      const checkInTime = new Date();
      const timeValidation = validateCheckInTime(checkInTime, session.start);
      if (!timeValidation.valid) {
        return error(400, timeValidation.message);
      }

      // 5. Validate GPS if provided
      let checkInMethod: CheckInMethod = 'MANUAL';
      let status: AttendanceStatus = 'PRESENT';
      let gpsValidation = null;

      if (body.lat !== undefined && body.lng !== undefined) {
        checkInMethod = 'GPS';

        if (session.locationId) {
          const location = await this.getLocation(tenantId, session.locationId);
          if (location?.lat !== undefined && location?.lng !== undefined) {
            gpsValidation = validateCheckIn(
              body.lat, body.lng,
              location.lat, location.lng,
              location.checkInRadiusMeters ?? DEFAULT_CHECK_IN_RADIUS_METERS
            );

            if (!gpsValidation.valid) {
              return error(400, gpsValidation.message);
            }
          }
        }
      }

      // 6. Late check?
      if (timeValidation.minutesFromStart > 0) {
        status = 'LATE';
      }

      // 7. Create attendance record
      const timestamp = now();
      const pk = `${tenantId}#${booking.sessionId}`;
      const gsi1pk = `${tenantId}#${booking.subjectId}`;

      const attendance: AttendanceRecord & { pk: string; gsi1pk: string } = {
        ...body,  // Accept any fields
        tenantId,
        sessionId: booking.sessionId,
        bookingId: body.bookingId,
        subjectId: booking.subjectId,
        subjectType: booking.subjectType,
        status,
        checkInTime: timestamp,
        checkInMethod,
        checkInLat: body.lat,
        checkInLng: body.lng,
        createdAt: timestamp,
        updatedAt: timestamp,
        pk,
        gsi1pk,
      };

      await docClient.send(new PutCommand({
        TableName: ATTENDANCE_TABLE,
        Item: attendance,
      }));

      console.log('[AttendanceService] Check-in recorded:', { bookingId: body.bookingId, status, method: checkInMethod });

      return success({
        ...attendance,
        timeValidation: { minutesFromStart: timeValidation.minutesFromStart, message: timeValidation.message },
        gpsValidation: gpsValidation ? { distanceMeters: gpsValidation.distanceMeters, message: gpsValidation.message } : null,
      }, 201);
    } catch (err: any) {
      console.error('[AttendanceService] POST error:', err);
      return error(500, err.message);
    }
  }

  /**
   * PATCH /scheduling/attendance
   * Manual override (admin)
   * Body: { sessionId, bookingId, status }
   */
  @ApiMethod('PATCH')
  async update(event: any) {
    console.log('[AttendanceService] PATCH - Override');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    try {
      const body = parseBody(event);
      
      if (!body.sessionId || !body.bookingId || !body.status) {
        return error(400, 'Missing sessionId, bookingId, or status');
      }

      if (!['PRESENT', 'LATE', 'NO_SHOW'].includes(body.status)) {
        return error(400, 'Invalid status');
      }

      // Find booking for subject info
      const booking = await this.findBooking(tenantId, body.bookingId);
      if (!booking) {
        return error(404, 'Booking not found');
      }

      const timestamp = now();
      const pk = `${tenantId}#${body.sessionId}`;
      const gsi1pk = `${tenantId}#${booking.subjectId}`;

      const attendance: AttendanceRecord & { pk: string; gsi1pk: string } = {
        ...body,  // Accept any fields
        tenantId,
        sessionId: body.sessionId,
        bookingId: body.bookingId,
        subjectId: booking.subjectId,
        subjectType: booking.subjectType,
        status: body.status,
        checkInTime: body.status !== 'NO_SHOW' ? timestamp : undefined,
        checkInMethod: 'OVERRIDE',
        createdAt: timestamp,
        updatedAt: timestamp,
        pk,
        gsi1pk,
      };

      await docClient.send(new PutCommand({
        TableName: ATTENDANCE_TABLE,
        Item: attendance,
      }));

      console.log('[AttendanceService] Override:', { bookingId: body.bookingId, status: body.status });
      return success({ overridden: true, ...attendance });
    } catch (err: any) {
      console.error('[AttendanceService] PATCH error:', err);
      return error(500, err.message);
    }
  }

  private async findBooking(tenantId: string, bookingId: string): Promise<Booking | null> {
    const result = await docClient.send(new QueryCommand({
      TableName: BOOKINGS_TABLE,
      IndexName: 'byCreatedAt',
      KeyConditionExpression: 'tenantId = :tenantId',
      FilterExpression: 'bookingId = :bookingId',
      ExpressionAttributeValues: { ':tenantId': tenantId, ':bookingId': bookingId },
    }));
    return (result.Items?.[0] as Booking) || null;
  }

  private async getAttendance(tenantId: string, sessionId: string, bookingId: string): Promise<AttendanceRecord | null> {
    const result = await docClient.send(new GetCommand({
      TableName: ATTENDANCE_TABLE,
      Key: { pk: `${tenantId}#${sessionId}`, bookingId },
    }));
    return (result.Item as AttendanceRecord) || null;
  }

  private async getSessionInfo(tenantId: string, sessionId: string): Promise<Session | null> {
    const { scheduleId, date } = parseSessionId(sessionId);

    const scheduleResult = await docClient.send(new GetCommand({
      TableName: SCHEDULES_TABLE,
      Key: { tenantId, scheduleId },
    }));

    if (!scheduleResult.Item) return null;
    const schedule = scheduleResult.Item as Schedule;

    const excResult = await docClient.send(new GetCommand({
      TableName: EXCEPTIONS_TABLE,
      Key: { pk: `${tenantId}#${scheduleId}`, occurrenceDate: date },
    }));

    const exception = excResult.Item as ScheduleException;
    if (exception?.type === 'CANCELLED') return null;

    const targetDate = new Date(date + 'T00:00:00Z');
    const sessions = generateSessions(schedule, {
      rangeStart: targetDate,
      rangeEnd: new Date(targetDate.getTime() + 24 * 60 * 60 * 1000),
      exceptions: exception ? [exception] : [],
    });

    return sessions.find(s => s.sessionId === sessionId) || null;
  }

  private async getLocation(tenantId: string, locationId: string): Promise<Location | null> {
    const result = await docClient.send(new GetCommand({
      TableName: LOCATIONS_TABLE,
      Key: { tenantId, locationId },
    }));
    return (result.Item as Location) || null;
  }
}

// Export individual handlers for Lambda
const service = new AttendanceService();
export const get = (event: any) => service.get(event);
export const create = (event: any) => service.create(event);
export const update = (event: any) => service.update(event);
