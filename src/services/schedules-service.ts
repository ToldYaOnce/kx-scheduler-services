/**
 * Schedules Service
 * 
 * CRUD operations for Schedules (recurring/one-off time patterns).
 * API Base Path: /scheduling/schedules
 */

import { ApiBasePath, ApiMethod } from '@toldyaonce/kx-cdk-lambda-utils';
import { getApiMethodHandlers } from '@toldyaonce/kx-cdk-lambda-utils/wrappers/rest-service';
import { Schedule, ScheduleType, HostRef } from '../domain/models';
import { validateRRule } from '../utils/rrule-utils';
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
  PutCommand,
  DeleteCommand
} from './base-service';

const TABLE = process.env.SCHEDULES_TABLE!;

/**
 * Schedules Service
 */
@ApiBasePath('/scheduling/schedules')
export class SchedulesService {

  @ApiMethod('GET')
  async get(event: any) {
    console.log('[SchedulesService] GET - Fetching schedules');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    const scheduleId = event.queryStringParameters?.scheduleId;
    const programId = event.queryStringParameters?.programId;

    try {
      if (scheduleId) {
        const result = await docClient.send(new GetCommand({
          TableName: TABLE,
          Key: { tenantId, scheduleId },
        }));
        
        if (!result.Item) {
          return error(404, 'Schedule not found');
        }
        return success(result.Item);
      }

      // Query by tenant, optionally filter by program
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'tenantId = :tenantId',
        ExpressionAttributeValues: { ':tenantId': tenantId },
      }));

      let schedules = result.Items || [];

      // Filter by programId if specified
      if (programId) {
        schedules = schedules.filter((s: any) => s.programId === programId);
      }

      return success(schedules);
    } catch (err: any) {
      console.error('[SchedulesService] GET error:', err);
      return error(500, err.message);
    }
  }

  @ApiMethod('POST')
  async create(event: any) {
    console.log('[SchedulesService] POST - Creating schedule');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    try {
      const body = parseBody(event);
      
      // Validate required fields
      const validation = this.validateInput(body);
      if (!validation.valid) {
        return error(400, validation.error!);
      }

      // Validate RRULE if recurring
      if (body.isRecurring && body.rrule) {
        const rruleValidation = validateRRule(body.rrule);
        if (!rruleValidation.valid) {
          return error(400, rruleValidation.error!);
        }
      }

      const timestamp = now();
      const scheduleId = body.scheduleId || generateId('sched');

      const schedule: Schedule & { gsi2pk?: string; gsi2sk?: string } = {
        ...body,  // Accept any fields
        tenantId,
        scheduleId,
        isRecurring: body.isRecurring ?? false,
        createdByUserId: getSubjectId(event) || undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      // Set GSI keys for host lookup
      if (body.hosts?.[0]) {
        schedule.gsi2pk = tenantId;
        schedule.gsi2sk = body.hosts[0].id;
      }

      await docClient.send(new PutCommand({
        TableName: TABLE,
        Item: schedule,
      }));

      console.log('[SchedulesService] Created schedule:', scheduleId);
      return success(schedule, 201);
    } catch (err: any) {
      console.error('[SchedulesService] POST error:', err);
      return error(500, err.message);
    }
  }

  @ApiMethod('PATCH')
  async update(event: any) {
    console.log('[SchedulesService] PATCH - Updating schedule');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    try {
      const body = parseBody(event);
      
      if (!body.scheduleId) {
        return error(400, 'Missing scheduleId in body');
      }

      const existing = await docClient.send(new GetCommand({
        TableName: TABLE,
        Key: { tenantId, scheduleId: body.scheduleId },
      }));

      if (!existing.Item) {
        return error(404, 'Schedule not found');
      }

      // Validate RRULE if being updated
      if (body.rrule) {
        const rruleValidation = validateRRule(body.rrule);
        if (!rruleValidation.valid) {
          return error(400, rruleValidation.error!);
        }
      }

      const current = existing.Item as Schedule;
      const updated: Schedule & { gsi2pk?: string; gsi2sk?: string } = {
        ...current,
        ...body,  // Accept any fields
        tenantId: current.tenantId,
        scheduleId: current.scheduleId,
        createdAt: current.createdAt,
        updatedAt: now(),
      };

      // Update GSI keys
      const primaryHost = (body.hosts ?? current.hosts)?.[0];
      if (primaryHost) {
        updated.gsi2pk = tenantId;
        updated.gsi2sk = primaryHost.id;
      }

      await docClient.send(new PutCommand({
        TableName: TABLE,
        Item: updated,
      }));

      console.log('[SchedulesService] Updated schedule:', body.scheduleId);
      return success(updated);
    } catch (err: any) {
      console.error('[SchedulesService] PATCH error:', err);
      return error(500, err.message);
    }
  }

  @ApiMethod('DELETE')
  async delete(event: any) {
    console.log('[SchedulesService] DELETE - Deleting schedule');
    
    const tenantId = getTenantId(event);
    const scheduleId = event.queryStringParameters?.scheduleId;

    if (!tenantId || !scheduleId) {
      return error(400, 'Missing tenantId or scheduleId');
    }

    try {
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE,
        Key: { tenantId, scheduleId },
      }));

      if (!existing.Item) {
        return error(404, 'Schedule not found');
      }

      await docClient.send(new DeleteCommand({
        TableName: TABLE,
        Key: { tenantId, scheduleId },
      }));

      console.log('[SchedulesService] Deleted schedule:', scheduleId);
      return success({ deleted: true, scheduleId });
    } catch (err: any) {
      console.error('[SchedulesService] DELETE error:', err);
      return error(500, err.message);
    }
  }

  private validateInput(body: any): { valid: boolean; error?: string } {
    if (!body.type || !['SESSION', 'BLOCK'].includes(body.type)) {
      return { valid: false, error: 'Invalid or missing type (must be SESSION or BLOCK)' };
    }
    if (!body.start) {
      return { valid: false, error: 'Missing required field: start' };
    }
    if (!body.end) {
      return { valid: false, error: 'Missing required field: end' };
    }
    if (!body.timezone) {
      return { valid: false, error: 'Missing required field: timezone' };
    }
    if (body.type === 'SESSION' && !body.programId) {
      return { valid: false, error: 'SESSION type requires programId' };
    }
    if (body.isRecurring && !body.rrule) {
      return { valid: false, error: 'Recurring schedules require an rrule' };
    }
    
    const start = new Date(body.start);
    const end = new Date(body.end);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return { valid: false, error: 'Invalid date format for start or end' };
    }
    if (end <= start) {
      return { valid: false, error: 'End time must be after start time' };
    }

    return { valid: true };
  }
}

// Export individual handlers for Lambda
const service = new SchedulesService();
export const get = (event: any) => service.get(event);
export const create = (event: any) => service.create(event);
export const update = (event: any) => service.update(event);
const deleteHandler = (event: any) => service.delete(event);
export { deleteHandler as delete };
