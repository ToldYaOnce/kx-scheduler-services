/**
 * Booking Events Handler
 * 
 * Subscribes to EventBridge events and processes booking requests.
 * 
 * Events Consumed:
 * - scheduling.booking_requested: Create a booking from agent/external request
 * 
 * Events Emitted:
 * - scheduling.booking_confirmed: Booking created successfully
 * - scheduling.booking_failed: Booking creation failed
 */

import { EventBridgeEvent } from 'aws-lambda';
import { 
  EventBridgeClient, 
  PutEventsCommand 
} from '@aws-sdk/client-eventbridge';
import { 
  docClient, 
  generateId, 
  now,
  QueryCommand,
  GetCommand,
  TransactWriteCommand
} from '../services/base-service';
import { Booking, Schedule, ScheduleException } from '../domain/models';
import { parseSessionId, generateSessions } from '../utils/rrule-utils';

const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE!;
const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE!;
const EXCEPTIONS_TABLE = process.env.SCHEDULE_EXCEPTIONS_TABLE!;
const SUMMARIES_TABLE = process.env.SESSION_SUMMARIES_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || 'default';

const eventBridge = new EventBridgeClient({});

/**
 * Payload for scheduling.booking_requested event
 */
interface BookingRequestedPayload {
  tenantId: string;
  channelId: string;
  subjectId: string;
  goalId?: string;
  timestamp?: string;
  
  // From goal config
  bookingType?: string;
  duration?: number;
  
  // Scheduling data extracted from conversation
  schedulingData: {
    preferredDate?: string;
    preferredTime?: string;
    normalizedDateTime?: string;
    programId?: string;
    programName?: string;
    sessionId?: string;
    leadBy?: string;
  };
  
  // Contact info for booking confirmation
  contactInfo?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };
}

/**
 * Payload for appointment.consultation_requested event
 */
interface ConsultationRequestedPayload {
  tenantId: string;
  channelId: string;
  leadId: string;  // Used as subjectId for booking
  goalId: string;
  timestamp: string;
  duration?: number;
  appointmentType: string;
  
  schedulingData: {
    preferredDate?: string;
    preferredTime?: string;
    normalizedDateTime?: string;
    programId?: string;
    programName?: string;
    sessionId?: string;
  };
  
  contactInfo?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };
}

/**
 * Payload for scheduling.booking_confirmed/failed event
 */
interface BookingResultPayload {
  tenantId: string;
  channelId: string;
  sessionId: string;
  bookingId: string;
  subjectId: string;
  goalId?: string;
  status: 'CONFIRMED' | 'FAILED';
  error?: string;
  sessionDetails?: {
    programId?: string;
    programName?: string;
    date: string;
    startTime: string;
    endTime: string;
    timezone: string;
    leadBy?: string;
  };
}

/**
 * Handle scheduling.booking_requested events
 */
export async function handleBookingRequested(
  event: EventBridgeEvent<'scheduling.booking_requested', BookingRequestedPayload>
): Promise<void> {
  const receivedAt = Date.now();
  const correlationId = event.id || generateId('corr');
  
  console.log('[BookingEventsHandler] TIMING_START', JSON.stringify({
    correlationId,
    eventType: 'booking_requested',
    receivedAt: new Date(receivedAt).toISOString(),
    eventTime: event.time,
    eventId: event.id,
    subjectId: event.detail?.subjectId,
    sessionId: event.detail?.schedulingData?.sessionId,
  }));

  const payload = event.detail;
  const { tenantId, subjectId, channelId, schedulingData } = payload;
  
  // Extract sessionId from schedulingData
  const sessionId = schedulingData?.sessionId;

  // Validate required fields
  if (!tenantId || !sessionId || !subjectId) {
    console.error('[BookingEventsHandler] Missing required fields:', { tenantId, sessionId, subjectId });
    await emitBookingResult({
      tenantId: tenantId || 'unknown',
      channelId: channelId || 'unknown',
      sessionId: sessionId || 'unknown',
      bookingId: '',
      subjectId: subjectId || 'unknown',
      status: 'FAILED',
      error: 'Missing required fields: tenantId, schedulingData.sessionId, and subjectId are required',
    }, correlationId, receivedAt);
    return;
  }

  try {
    // 1. Validate session exists and get capacity info
    const getSessionStart = Date.now();
    const sessionInfo = await getSessionInfo(tenantId, sessionId);
    console.log('[BookingEventsHandler] TIMING_STEP', JSON.stringify({
      correlationId,
      step: 'getSessionInfo',
      durationMs: Date.now() - getSessionStart,
    }));
    
    if (!sessionInfo) {
      await emitBookingResult({
        tenantId,
        channelId,
        sessionId,
        bookingId: '',
        subjectId,
        goalId: payload.goalId,
        status: 'FAILED',
        error: 'Session not found or has been cancelled',
      }, correlationId, receivedAt);
      return;
    }

    // 2. Check for existing booking
    const checkBookingStart = Date.now();
    const existingBooking = await findExistingBooking(tenantId, sessionId, subjectId);
    console.log('[BookingEventsHandler] TIMING_STEP', JSON.stringify({
      correlationId,
      step: 'findExistingBooking',
      durationMs: Date.now() - checkBookingStart,
    }));
    
    if (existingBooking && existingBooking.status === 'CONFIRMED') {
      await emitBookingResult({
        tenantId,
        channelId,
        sessionId,
        bookingId: existingBooking.bookingId,
        subjectId,
        goalId: payload.goalId,
        status: 'CONFIRMED',
        sessionDetails: sessionInfo.details,
        // Note: Already had a booking, but we return success with existing bookingId
      }, correlationId, receivedAt);
      return;
    }

    // 3. Create the booking
    const timestamp = now();
    const bookingId = generateId('book');
    const pk = `${tenantId}#${sessionId}`;
    const gsi1pk = `${tenantId}#${subjectId}`;

    const booking: Booking & { pk: string; gsi1pk: string } = {
      tenantId,
      sessionId,
      bookingId,
      subjectId,
      subjectType: 'PROSPECT', // Could be MEMBER or PROSPECT - stored for reference
      status: 'CONFIRMED',
      source: 'agent',
      createdAt: timestamp,
      pk,
      gsi1pk,
      // Store additional context for tracking and follow-up
      ...(payload.contactInfo && { contactInfo: payload.contactInfo }),
      ...(payload.channelId && { channelId: payload.channelId }),
      ...(payload.goalId && { goalId: payload.goalId }),
      ...(payload.bookingType && { bookingType: payload.bookingType }),
      // Store scheduling context for reference
      ...(schedulingData.programId && { programId: schedulingData.programId }),
      ...(schedulingData.programName && { programName: schedulingData.programName }),
      ...(schedulingData.leadBy && { leadBy: schedulingData.leadBy }),
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

    // Add capacity update - always sync capacity from schedule to handle updates
    if (sessionInfo.capacity !== undefined && sessionInfo.capacity !== null) {
      transactItems.push({
        Update: {
          TableName: SUMMARIES_TABLE,
          Key: { tenantId, sessionId },
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
      // No capacity limit
      transactItems.push({
        Update: {
          TableName: SUMMARIES_TABLE,
          Key: { tenantId, sessionId },
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

    const transactStart = Date.now();
    await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
    console.log('[BookingEventsHandler] TIMING_STEP', JSON.stringify({
      correlationId,
      step: 'transactWrite',
      durationMs: Date.now() - transactStart,
      bookingId,
    }));

    // 4. Emit success event
    await emitBookingResult({
      tenantId,
      channelId,
      sessionId,
      bookingId,
      subjectId,
      goalId: payload.goalId,
      status: 'CONFIRMED',
      sessionDetails: sessionInfo.details,
    }, correlationId, receivedAt);

  } catch (err: any) {
    console.error('[BookingEventsHandler] Error creating booking:', err);

    let errorMessage = err.message;
    if (err.name === 'TransactionCanceledException') {
      errorMessage = 'Session is at capacity';
    }

    await emitBookingResult({
      tenantId,
      channelId,
      sessionId,
      bookingId: '',
      subjectId,
      goalId: payload.goalId,
      status: 'FAILED',
      error: errorMessage,
    }, correlationId, receivedAt);
  }
}

/**
 * Get session info including capacity and details for confirmation
 */
async function getSessionInfo(tenantId: string, sessionId: string): Promise<{
  capacity?: number;
  details: BookingResultPayload['sessionDetails'];
} | null> {
  const { scheduleId, date } = parseSessionId(sessionId);

  const scheduleResult = await docClient.send(new GetCommand({
    TableName: SCHEDULES_TABLE,
    Key: { tenantId, scheduleId },
  }));

  const schedule = scheduleResult.Item as Schedule;
  if (!schedule) return null;

  // Check for exception (cancellation or override)
  const excResult = await docClient.send(new GetCommand({
    TableName: EXCEPTIONS_TABLE,
    Key: { pk: `${tenantId}#${scheduleId}`, occurrenceDate: date },
  }));

  const exception = excResult.Item as ScheduleException;
  if (exception?.type === 'CANCELLED') return null;

  // Generate session to get actual times
  const rangeStart = new Date(date + 'T00:00:00Z');
  const rangeEnd = new Date(date + 'T23:59:59Z');
  // Extend for timezone safety
  rangeStart.setUTCHours(rangeStart.getUTCHours() - 14);
  rangeEnd.setUTCHours(rangeEnd.getUTCHours() + 12);

  const sessions = generateSessions(schedule, {
    rangeStart,
    rangeEnd,
    exceptions: exception ? [exception] : [],
  });

  const session = sessions.find(s => s.sessionId === sessionId);
  if (!session) return null;

  // Format times for human-readable confirmation
  const startDate = new Date(session.start);
  const endDate = new Date(session.end);
  
  const formatTime = (d: Date, tz: string) => d.toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return {
    capacity: exception?.overrideCapacity ?? schedule.baseCapacity,
    details: {
      programId: schedule.programId,
      date: session.date,
      startTime: formatTime(startDate, schedule.timezone),
      endTime: formatTime(endDate, schedule.timezone),
      timezone: schedule.timezone,
      leadBy: (schedule as any).leadBy,  // leadBy is stored on schedule
    },
  };
}

/**
 * Check for existing booking
 */
async function findExistingBooking(
  tenantId: string, 
  sessionId: string, 
  subjectId: string
): Promise<Booking | null> {
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

/**
 * Emit booking result event
 */
async function emitBookingResult(
  payload: BookingResultPayload,
  correlationId?: string,
  receivedAt?: number
): Promise<void> {
  const emitStart = Date.now();
  const detailType = payload.status === 'CONFIRMED' 
    ? 'scheduling.booking_confirmed' 
    : 'scheduling.booking_failed';

  try {
    await eventBridge.send(new PutEventsCommand({
      Entries: [
        {
          EventBusName: EVENT_BUS_NAME,
          Source: 'kx.scheduler',
          DetailType: detailType,
          Detail: JSON.stringify(payload),
        },
      ],
    }));
    
    const completedAt = Date.now();
    console.log('[BookingEventsHandler] TIMING_END', JSON.stringify({
      correlationId,
      status: payload.status,
      detailType,
      bookingId: payload.bookingId || undefined,
      error: payload.error || undefined,
      receivedAt: receivedAt ? new Date(receivedAt).toISOString() : undefined,
      completedAt: new Date(completedAt).toISOString(),
      totalDurationMs: receivedAt ? completedAt - receivedAt : undefined,
      emitDurationMs: completedAt - emitStart,
      sessionId: payload.sessionId,
      subjectId: payload.subjectId,
    }));
  } catch (err) {
    console.error('[BookingEventsHandler] Failed to emit event:', err);
    // Don't throw - we don't want to retry the whole booking
  }
}

/**
 * Handle appointment.consultation_requested events
 * Similar to booking_requested but uses leadId as subjectId and emits appointment.scheduled
 */
export async function handleConsultationRequested(
  event: EventBridgeEvent<'appointment.consultation_requested', ConsultationRequestedPayload>
): Promise<void> {
  const receivedAt = Date.now();
  // Use event ID as correlation ID, or generate one if not available
  const correlationId = event.id || generateId('corr');
  
  console.log('[BookingEventsHandler] TIMING_START', JSON.stringify({
    correlationId,
    receivedAt: new Date(receivedAt).toISOString(),
    eventTime: event.time,
    eventId: event.id,
    leadId: event.detail?.leadId,
    sessionId: event.detail?.schedulingData?.sessionId,
  }));

  const payload = event.detail;
  const { tenantId, leadId, channelId, schedulingData, goalId } = payload;
  
  // Use leadId as subjectId for the booking
  const subjectId = leadId;
  const sessionId = schedulingData?.sessionId;

  // Validate required fields
  if (!tenantId || !sessionId || !subjectId) {
    console.error('[BookingEventsHandler] Missing required fields:', { tenantId, sessionId, subjectId });
    await emitAppointmentResult(payload, '', 'FAILED', 'Missing required fields: tenantId, schedulingData.sessionId, and leadId are required', undefined, correlationId, receivedAt);
    return;
  }

  try {
    // 1. Validate session exists and get capacity info
    const getSessionStart = Date.now();
    const sessionInfo = await getSessionInfo(tenantId, sessionId);
    console.log('[BookingEventsHandler] TIMING_STEP', JSON.stringify({
      correlationId,
      step: 'getSessionInfo',
      durationMs: Date.now() - getSessionStart,
    }));
    
    if (!sessionInfo) {
      await emitAppointmentResult(payload, '', 'FAILED', 'Session not found or has been cancelled', undefined, correlationId, receivedAt);
      return;
    }

    // 2. Check for existing booking
    const checkBookingStart = Date.now();
    const existingBooking = await findExistingBooking(tenantId, sessionId, subjectId);
    console.log('[BookingEventsHandler] TIMING_STEP', JSON.stringify({
      correlationId,
      step: 'findExistingBooking',
      durationMs: Date.now() - checkBookingStart,
    }));
    
    if (existingBooking && existingBooking.status === 'CONFIRMED') {
      // Already booked - emit success with existing bookingId
      await emitAppointmentResult(payload, existingBooking.bookingId, 'CONFIRMED', undefined, sessionInfo.details, correlationId, receivedAt);
      return;
    }

    // 3. Create the booking
    const timestamp = now();
    const bookingId = generateId('book');
    const pk = `${tenantId}#${sessionId}`;
    const gsi1pk = `${tenantId}#${subjectId}`;

    const booking: Booking & { pk: string; gsi1pk: string } = {
      tenantId,
      sessionId,
      bookingId,
      subjectId,
      subjectType: 'LEAD',
      status: 'CONFIRMED',
      source: 'agent',
      createdAt: timestamp,
      pk,
      gsi1pk,
      // Store additional context
      ...(payload.contactInfo && { contactInfo: payload.contactInfo }),
      ...(payload.channelId && { channelId: payload.channelId }),
      ...(payload.goalId && { goalId: payload.goalId }),
      ...(payload.appointmentType && { appointmentType: payload.appointmentType }),
      ...(schedulingData.programId && { programId: schedulingData.programId }),
      ...(schedulingData.programName && { programName: schedulingData.programName }),
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

    // Add capacity update - always sync capacity from schedule to handle updates
    if (sessionInfo.capacity !== undefined && sessionInfo.capacity !== null) {
      transactItems.push({
        Update: {
          TableName: SUMMARIES_TABLE,
          Key: { tenantId, sessionId },
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
      transactItems.push({
        Update: {
          TableName: SUMMARIES_TABLE,
          Key: { tenantId, sessionId },
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

    const transactStart = Date.now();
    await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
    console.log('[BookingEventsHandler] TIMING_STEP', JSON.stringify({
      correlationId,
      step: 'transactWrite',
      durationMs: Date.now() - transactStart,
      bookingId,
    }));

    // 4. Emit success event
    await emitAppointmentResult(payload, bookingId, 'CONFIRMED', undefined, sessionInfo.details, correlationId, receivedAt);

  } catch (err: any) {
    console.error('[BookingEventsHandler] Error creating consultation booking:', err);

    let errorMessage = err.message;
    if (err.name === 'TransactionCanceledException') {
      errorMessage = 'Session is at capacity';
    }

    await emitAppointmentResult(payload, '', 'FAILED', errorMessage, undefined, correlationId, receivedAt);
  }
}

/**
 * Emit appointment.scheduled or appointment.failed event
 * Returns the full original payload plus booking result
 */
async function emitAppointmentResult(
  originalPayload: ConsultationRequestedPayload,
  bookingId: string,
  status: 'CONFIRMED' | 'FAILED',
  error?: string,
  sessionDetails?: BookingResultPayload['sessionDetails'],
  correlationId?: string,
  receivedAt?: number
): Promise<void> {
  const emitStart = Date.now();
  const detailType = status === 'CONFIRMED' 
    ? 'appointment.scheduled' 
    : 'appointment.failed';

  // Build result payload - include original payload plus booking result
  const resultPayload = {
    ...originalPayload,
    bookingId,
    status,
    ...(error && { error }),
    ...(sessionDetails && { sessionDetails }),
  };

  try {
    await eventBridge.send(new PutEventsCommand({
      Entries: [
        {
          EventBusName: EVENT_BUS_NAME,
          Source: 'kx.scheduler',
          DetailType: detailType,
          Detail: JSON.stringify(resultPayload),
        },
      ],
    }));
    
    const completedAt = Date.now();
    console.log('[BookingEventsHandler] TIMING_END', JSON.stringify({
      correlationId,
      status,
      detailType,
      bookingId: bookingId || undefined,
      error: error || undefined,
      receivedAt: receivedAt ? new Date(receivedAt).toISOString() : undefined,
      completedAt: new Date(completedAt).toISOString(),
      totalDurationMs: receivedAt ? completedAt - receivedAt : undefined,
      emitDurationMs: completedAt - emitStart,
      leadId: originalPayload.leadId,
      sessionId: originalPayload.schedulingData?.sessionId,
    }));
  } catch (err) {
    console.error('[BookingEventsHandler] Failed to emit appointment event:', err);
  }
}

/**
 * Lambda handler for EventBridge events
 */
export const handler = async (event: EventBridgeEvent<string, any>): Promise<void> => {
  console.log('[BookingEventsHandler] Event received:', event['detail-type']);

  switch (event['detail-type']) {
    case 'scheduling.booking_requested':
      await handleBookingRequested(event as EventBridgeEvent<'scheduling.booking_requested', BookingRequestedPayload>);
      break;
    case 'appointment.consultation_requested':
      await handleConsultationRequested(event as EventBridgeEvent<'appointment.consultation_requested', ConsultationRequestedPayload>);
      break;
    default:
      console.log('[BookingEventsHandler] Unhandled event type:', event['detail-type']);
  }
};

