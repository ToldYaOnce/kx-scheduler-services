/**
 * Bookings Service
 * 
 * Handles bookings with TRANSACTIONAL capacity enforcement.
 * API Base Path: /scheduling/bookings
 */

import { ApiBasePath, ApiMethod } from '@toldyaonce/kx-cdk-lambda-utils';
import { getApiMethodHandlers } from '@toldyaonce/kx-cdk-lambda-utils/wrappers/rest-service';
import { Booking, BookingStatus, Schedule, ScheduleException } from '../domain/models';
import { parseSessionId } from '../utils/rrule-utils';
import { 
  docClient, 
  success, 
  error, 
  getTenantId, 
  getSubjectId,
  parseBody, 
  generateId, 
  now,
  QueryCommand,
  GetCommand,
  TransactWriteCommand
} from './base-service';

const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE!;
const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE!;
const EXCEPTIONS_TABLE = process.env.SCHEDULE_EXCEPTIONS_TABLE!;
const SUMMARIES_TABLE = process.env.SESSION_SUMMARIES_TABLE!;

/**
 * Bookings Service
 */
@ApiBasePath('/scheduling/bookings')
export class BookingsService {

  /**
   * GET /scheduling/bookings
   * - With sessionId param: list bookings for a session
   * - Without: list bookings for current user
   */
  @ApiMethod('GET')
  async get(event: any) {
    console.log('[BookingsService] GET - Fetching bookings');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    const params = event.queryStringParameters || {};

    try {
      if (params.sessionId) {
        // List bookings for a session
        const pk = `${tenantId}#${params.sessionId}`;
        const result = await docClient.send(new QueryCommand({
          TableName: BOOKINGS_TABLE,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': pk },
        }));
        return success(result.Items || []);
      }

      // List bookings for current user
      const subjectId = getSubjectId(event) || params.subjectId;
      if (!subjectId) {
        return error(400, 'Missing subjectId');
      }

      const result = await docClient.send(new QueryCommand({
        TableName: BOOKINGS_TABLE,
        IndexName: 'bySubject',
        KeyConditionExpression: 'gsi1pk = :gsi1pk',
        ExpressionAttributeValues: { ':gsi1pk': `${tenantId}#${subjectId}` },
        ScanIndexForward: false,
        Limit: parseInt(params.limit) || 50,
      }));

      let bookings = result.Items || [];
      if (params.status) {
        bookings = bookings.filter((b: any) => b.status === params.status);
      }

      return success(bookings);
    } catch (err: any) {
      console.error('[BookingsService] GET error:', err);
      return error(500, err.message);
    }
  }

  /**
   * POST /scheduling/bookings
   * Create a booking with transactional capacity enforcement
   * Body: { sessionId, subjectId?, subjectType?, source?, notes? }
   */
  @ApiMethod('POST')
  async create(event: any) {
    console.log('[BookingsService] POST - Creating booking');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    try {
      const body = parseBody(event);
      
      if (!body.sessionId) {
        return error(400, 'Missing sessionId');
      }

      const subjectId = body.subjectId || getSubjectId(event);
      const subjectType = body.subjectType || 'USER';

      if (!subjectId) {
        return error(400, 'Missing subjectId');
      }

      // 1. Get session info (capacity)
      const sessionInfo = await this.getSessionInfo(tenantId, body.sessionId);
      if (!sessionInfo) {
        return error(404, 'Session not found');
      }

      // 2. Check for duplicate booking
      const existing = await this.findExistingBooking(tenantId, body.sessionId, subjectId);
      if (existing && existing.status === 'CONFIRMED') {
        return error(409, 'Already have a confirmed booking for this session');
      }

      // 3. Create booking with transaction
      const timestamp = now();
      const bookingId = generateId('book');
      const pk = `${tenantId}#${body.sessionId}`;
      const gsi1pk = `${tenantId}#${subjectId}`;

      const booking: Booking & { pk: string; gsi1pk: string } = {
        ...body,  // Accept any fields
        tenantId,
        sessionId: body.sessionId,
        bookingId,
        subjectId,
        subjectType,
        status: 'CONFIRMED',
        source: body.source || 'api',
        createdAt: timestamp,
        pk,
        gsi1pk,
      };

      // Build transaction
      const transactItems: any[] = [
        {
          Put: {
            TableName: BOOKINGS_TABLE,
            Item: booking,
            ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(bookingId)',
          },
        },
      ];

      // Add capacity check - always sync capacity from schedule to handle updates
      if (sessionInfo.capacity !== undefined && sessionInfo.capacity !== null) {
        transactItems.push({
          Update: {
            TableName: SUMMARIES_TABLE,
            Key: { tenantId, sessionId: body.sessionId },
            UpdateExpression: `
              SET bookedCount = if_not_exists(bookedCount, :zero) + :one,
                  #cap = :capacity,
                  updatedAt = :now
            `,
            ConditionExpression: 'attribute_not_exists(bookedCount) OR (bookedCount < :capacity)',
            ExpressionAttributeNames: { '#cap': 'capacity' },
            ExpressionAttributeValues: {
              ':zero': 0,
              ':one': 1,
              ':capacity': sessionInfo.capacity,
              ':now': timestamp,
            },
          },
        });
      } else {
        // No capacity limit, just increment
        transactItems.push({
          Update: {
            TableName: SUMMARIES_TABLE,
            Key: { tenantId, sessionId: body.sessionId },
            UpdateExpression: `
              SET bookedCount = if_not_exists(bookedCount, :zero) + :one,
                  updatedAt = :now
            `,
            ExpressionAttributeValues: {
              ':zero': 0,
              ':one': 1,
              ':now': timestamp,
            },
          },
        });
      }

      try {
        await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
        console.log('[BookingsService] Created booking:', bookingId);
        return success(booking, 201);
      } catch (txErr: any) {
        if (txErr.name === 'TransactionCanceledException') {
          return error(409, 'Session is at capacity');
        }
        throw txErr;
      }
    } catch (err: any) {
      console.error('[BookingsService] POST error:', err);
      return error(500, err.message);
    }
  }

  /**
   * DELETE /scheduling/bookings?bookingId=xxx
   * Cancel a booking
   */
  @ApiMethod('DELETE')
  async delete(event: any) {
    console.log('[BookingsService] DELETE - Cancelling booking');
    
    const tenantId = getTenantId(event);
    const bookingId = event.queryStringParameters?.bookingId;

    if (!tenantId || !bookingId) {
      return error(400, 'Missing tenantId or bookingId');
    }

    try {
      // Find the booking
      const booking = await this.findBookingById(tenantId, bookingId);
      if (!booking) {
        return error(404, 'Booking not found');
      }

      // Verify ownership
      const subjectId = getSubjectId(event);
      if (subjectId && booking.subjectId !== subjectId) {
        return error(403, 'Not authorized');
      }

      if (booking.status === 'CANCELLED') {
        return error(400, 'Already cancelled');
      }

      const timestamp = now();

      // Transaction: update booking + decrement counter
      await docClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: BOOKINGS_TABLE,
              Key: { pk: (booking as any).pk, bookingId },
              UpdateExpression: 'SET #status = :cancelled, cancelledAt = :now',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':cancelled': 'CANCELLED', ':now': timestamp },
            },
          },
          {
            Update: {
              TableName: SUMMARIES_TABLE,
              Key: { tenantId, sessionId: booking.sessionId },
              UpdateExpression: 'SET bookedCount = bookedCount - :one, updatedAt = :now',
              ConditionExpression: 'bookedCount > :zero',
              ExpressionAttributeValues: { ':one': 1, ':zero': 0, ':now': timestamp },
            },
          },
        ],
      }));

      console.log('[BookingsService] Cancelled booking:', bookingId);
      return success({ cancelled: true, bookingId, sessionId: booking.sessionId });
    } catch (err: any) {
      console.error('[BookingsService] DELETE error:', err);
      return error(500, err.message);
    }
  }

  private async getSessionInfo(tenantId: string, sessionId: string): Promise<{ capacity?: number } | null> {
    const { scheduleId, date } = parseSessionId(sessionId);

    const scheduleResult = await docClient.send(new GetCommand({
      TableName: SCHEDULES_TABLE,
      Key: { tenantId, scheduleId },
    }));

    const schedule = scheduleResult.Item as Schedule;
    if (!schedule) return null;

    // Check for exception
    const excResult = await docClient.send(new GetCommand({
      TableName: EXCEPTIONS_TABLE,
      Key: { pk: `${tenantId}#${scheduleId}`, occurrenceDate: date },
    }));

    const exception = excResult.Item as ScheduleException;
    if (exception?.type === 'CANCELLED') return null;

    return { capacity: exception?.overrideCapacity ?? schedule.baseCapacity };
  }

  private async findExistingBooking(tenantId: string, sessionId: string, subjectId: string): Promise<Booking | null> {
    const pk = `${tenantId}#${sessionId}`;
    const result = await docClient.send(new QueryCommand({
      TableName: BOOKINGS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      FilterExpression: 'subjectId = :subjectId AND #status <> :cancelled',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': pk, ':subjectId': subjectId, ':cancelled': 'CANCELLED' },
    }));
    return (result.Items?.[0] as Booking) || null;
  }

  private async findBookingById(tenantId: string, bookingId: string): Promise<Booking | null> {
    const result = await docClient.send(new QueryCommand({
      TableName: BOOKINGS_TABLE,
      IndexName: 'byCreatedAt',
      KeyConditionExpression: 'tenantId = :tenantId',
      FilterExpression: 'bookingId = :bookingId',
      ExpressionAttributeValues: { ':tenantId': tenantId, ':bookingId': bookingId },
    }));
    return (result.Items?.[0] as Booking) || null;
  }
}

// Export individual handlers for Lambda
const service = new BookingsService();
export const get = (event: any) => service.get(event);
export const create = (event: any) => service.create(event);
const deleteHandler = (event: any) => service.delete(event);
export { deleteHandler as delete };
