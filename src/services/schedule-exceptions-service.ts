/**
 * Schedule Exceptions Service
 * 
 * CRUD operations for per-date overrides and cancellations.
 * API Base Path: /scheduling/exceptions
 */

import { ApiBasePath, ApiMethod } from '@toldyaonce/kx-cdk-lambda-utils';
import { getApiMethodHandlers } from '@toldyaonce/kx-cdk-lambda-utils/wrappers/rest-service';
import { ScheduleException, ScheduleExceptionType, HostRef } from '../domain/models';
import { 
  docClient, 
  success, 
  error, 
  getTenantId, 
  parseBody, 
  now,
  QueryCommand,
  GetCommand,
  PutCommand,
  DeleteCommand
} from './base-service';

const EXCEPTIONS_TABLE = process.env.SCHEDULE_EXCEPTIONS_TABLE!;
const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE!;

/**
 * Schedule Exceptions Service
 */
@ApiBasePath('/scheduling/exceptions')
export class ScheduleExceptionsService {

  /**
   * GET /scheduling/exceptions?scheduleId=xxx
   */
  @ApiMethod('GET')
  async get(event: any) {
    console.log('[ScheduleExceptionsService] GET - Fetching exceptions');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    const params = event.queryStringParameters || {};
    
    if (!params.scheduleId) {
      return error(400, 'Missing scheduleId');
    }

    try {
      const pk = `${tenantId}#${params.scheduleId}`;

      // If occurrenceDate specified, get single exception
      if (params.occurrenceDate) {
        const result = await docClient.send(new GetCommand({
          TableName: EXCEPTIONS_TABLE,
          Key: { pk, occurrenceDate: params.occurrenceDate },
        }));

        if (!result.Item) {
          return error(404, 'Exception not found');
        }
        return success(result.Item);
      }

      // List all exceptions for schedule
      let keyCondition = 'pk = :pk';
      const expressionValues: any = { ':pk': pk };

      if (params.startDate && params.endDate) {
        keyCondition += ' AND occurrenceDate BETWEEN :start AND :end';
        expressionValues[':start'] = params.startDate;
        expressionValues[':end'] = params.endDate;
      }

      const result = await docClient.send(new QueryCommand({
        TableName: EXCEPTIONS_TABLE,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeValues: expressionValues,
      }));

      return success(result.Items || []);
    } catch (err: any) {
      console.error('[ScheduleExceptionsService] GET error:', err);
      return error(500, err.message);
    }
  }

  /**
   * POST /scheduling/exceptions
   * Create exception (cancellation or override)
   * Body: { scheduleId, occurrenceDate, type, override* fields }
   */
  @ApiMethod('POST')
  async create(event: any) {
    console.log('[ScheduleExceptionsService] POST - Creating exception');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    try {
      const body = parseBody(event);
      
      if (!body.scheduleId) {
        return error(400, 'Missing scheduleId');
      }
      if (!body.occurrenceDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.occurrenceDate)) {
        return error(400, 'Missing or invalid occurrenceDate (use YYYY-MM-DD)');
      }
      if (!body.type || !['CANCELLED', 'OVERRIDE'].includes(body.type)) {
        return error(400, 'Invalid type (must be CANCELLED or OVERRIDE)');
      }

      // Verify schedule exists
      const scheduleResult = await docClient.send(new GetCommand({
        TableName: SCHEDULES_TABLE,
        Key: { tenantId, scheduleId: body.scheduleId },
      }));

      if (!scheduleResult.Item) {
        return error(404, 'Schedule not found');
      }

      const timestamp = now();
      const pk = `${tenantId}#${body.scheduleId}`;

      const exception: ScheduleException & { pk: string } = {
        ...body,  // Accept any fields
        tenantId,
        scheduleId: body.scheduleId,
        occurrenceDate: body.occurrenceDate,
        createdAt: timestamp,
        updatedAt: timestamp,
        pk,
      };

      await docClient.send(new PutCommand({
        TableName: EXCEPTIONS_TABLE,
        Item: exception,
      }));

      console.log('[ScheduleExceptionsService] Created exception:', { scheduleId: body.scheduleId, occurrenceDate: body.occurrenceDate, type: body.type });
      return success(exception, 201);
    } catch (err: any) {
      console.error('[ScheduleExceptionsService] POST error:', err);
      return error(500, err.message);
    }
  }

  /**
   * PATCH /scheduling/exceptions
   * Update exception
   * Body: { scheduleId, occurrenceDate, ... fields to update }
   */
  @ApiMethod('PATCH')
  async update(event: any) {
    console.log('[ScheduleExceptionsService] PATCH - Updating exception');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    try {
      const body = parseBody(event);
      
      if (!body.scheduleId || !body.occurrenceDate) {
        return error(400, 'Missing scheduleId or occurrenceDate');
      }

      const pk = `${tenantId}#${body.scheduleId}`;

      const existing = await docClient.send(new GetCommand({
        TableName: EXCEPTIONS_TABLE,
        Key: { pk, occurrenceDate: body.occurrenceDate },
      }));

      if (!existing.Item) {
        return error(404, 'Exception not found');
      }

      const current = existing.Item as ScheduleException & { pk: string };
      const newType = body.type ?? current.type;

      const updated: ScheduleException & { pk: string } = {
        ...current,
        ...body,  // Accept any fields
        tenantId: current.tenantId,
        scheduleId: current.scheduleId,
        occurrenceDate: current.occurrenceDate,
        pk: current.pk,
        createdAt: current.createdAt,
        type: newType,  // Keep the validated type
        updatedAt: now(),
      };

      await docClient.send(new PutCommand({
        TableName: EXCEPTIONS_TABLE,
        Item: updated,
      }));

      console.log('[ScheduleExceptionsService] Updated exception:', { scheduleId: body.scheduleId, occurrenceDate: body.occurrenceDate });
      return success(updated);
    } catch (err: any) {
      console.error('[ScheduleExceptionsService] PATCH error:', err);
      return error(500, err.message);
    }
  }

  /**
   * DELETE /scheduling/exceptions?scheduleId=xxx&occurrenceDate=yyy
   */
  @ApiMethod('DELETE')
  async delete(event: any) {
    console.log('[ScheduleExceptionsService] DELETE - Deleting exception');
    
    const tenantId = getTenantId(event);
    const params = event.queryStringParameters || {};

    if (!tenantId || !params.scheduleId || !params.occurrenceDate) {
      return error(400, 'Missing tenantId, scheduleId, or occurrenceDate');
    }

    try {
      const pk = `${tenantId}#${params.scheduleId}`;

      const existing = await docClient.send(new GetCommand({
        TableName: EXCEPTIONS_TABLE,
        Key: { pk, occurrenceDate: params.occurrenceDate },
      }));

      if (!existing.Item) {
        return error(404, 'Exception not found');
      }

      await docClient.send(new DeleteCommand({
        TableName: EXCEPTIONS_TABLE,
        Key: { pk, occurrenceDate: params.occurrenceDate },
      }));

      console.log('[ScheduleExceptionsService] Deleted exception:', { scheduleId: params.scheduleId, occurrenceDate: params.occurrenceDate });
      return success({ deleted: true, scheduleId: params.scheduleId, occurrenceDate: params.occurrenceDate });
    } catch (err: any) {
      console.error('[ScheduleExceptionsService] DELETE error:', err);
      return error(500, err.message);
    }
  }
}

// Export individual handlers for Lambda
const service = new ScheduleExceptionsService();
export const get = (event: any) => service.get(event);
export const create = (event: any) => service.create(event);
export const update = (event: any) => service.update(event);
const deleteHandler = (event: any) => service.delete(event);
export { deleteHandler as delete };
