/**
 * Programs Service
 * 
 * CRUD operations for Programs (what's being scheduled).
 * API Base Path: /scheduling/programs
 */

import { ApiBasePath, ApiMethod } from '@toldyaonce/kx-cdk-lambda-utils';
import { getApiMethodHandlers } from '@toldyaonce/kx-cdk-lambda-utils/wrappers/rest-service';
import { Program } from '../domain/models';
import { 
  docClient, 
  success, 
  error, 
  getTenantId, 
  parseBody, 
  generateId, 
  now,
  QueryCommand,
  GetCommand,
  PutCommand,
  DeleteCommand
} from './base-service';

const TABLE = process.env.PROGRAMS_TABLE!;

/**
 * Programs Service
 * 
 * Endpoints:
 * - GET    /scheduling/programs          - List all programs for tenant
 * - POST   /scheduling/programs          - Create program
 * - PATCH  /scheduling/programs          - Update program (by programId in body)
 * - DELETE /scheduling/programs          - Delete program (by query params)
 */
@ApiBasePath('/scheduling/programs')
export class ProgramsService {

  /**
   * List all programs for a tenant
   * GET /scheduling/programs?tenantId=xxx
   */
  @ApiMethod('GET')
  async get(event: any) {
    console.log('[ProgramsService] GET - Fetching programs');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    const programId = event.queryStringParameters?.programId;

    try {
      if (programId) {
        // Get single program
        const result = await docClient.send(new GetCommand({
          TableName: TABLE,
          Key: { tenantId, programId },
        }));
        
        if (!result.Item) {
          return error(404, 'Program not found');
        }
        return success(result.Item);
      }

      // List all programs
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'tenantId = :tenantId',
        ExpressionAttributeValues: { ':tenantId': tenantId },
      }));

      return success(result.Items || []);
    } catch (err: any) {
      console.error('[ProgramsService] GET error:', err);
      return error(500, err.message);
    }
  }

  /**
   * Create a new program
   * POST /scheduling/programs
   */
  @ApiMethod('POST')
  async create(event: any) {
    console.log('[ProgramsService] POST - Creating program');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    try {
      const body = parseBody(event);
      
      if (!body.name) {
        return error(400, 'Missing required field: name');
      }

      const timestamp = now();
      const program: Program = {
        ...body,  // Accept any fields sent by client
        tenantId, // Override with authenticated tenant
        programId: body.programId || generateId('prog'),
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await docClient.send(new PutCommand({
        TableName: TABLE,
        Item: program,
      }));

      console.log('[ProgramsService] Created program:', program.programId);
      return success(program, 201);
    } catch (err: any) {
      console.error('[ProgramsService] POST error:', err);
      return error(500, err.message);
    }
  }

  /**
   * Update a program
   * PATCH /scheduling/programs (programId in body)
   */
  @ApiMethod('PATCH')
  async update(event: any) {
    console.log('[ProgramsService] PATCH - Updating program');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    try {
      const body = parseBody(event);
      
      if (!body.programId) {
        return error(400, 'Missing programId in body');
      }

      // Check if exists
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE,
        Key: { tenantId, programId: body.programId },
      }));

      if (!existing.Item) {
        return error(404, 'Program not found');
      }

      const current = existing.Item as Program;
      const updated: Program = {
        ...current,   // Keep existing values
        ...body,      // Override with new values from body
        tenantId: current.tenantId,  // Protect tenant isolation
        programId: current.programId, // Protect primary key
        createdAt: current.createdAt, // Preserve original creation time
        updatedAt: now(),
      };

      await docClient.send(new PutCommand({
        TableName: TABLE,
        Item: updated,
      }));

      console.log('[ProgramsService] Updated program:', body.programId);
      return success(updated);
    } catch (err: any) {
      console.error('[ProgramsService] PATCH error:', err);
      return error(500, err.message);
    }
  }

  /**
   * Delete a program
   * DELETE /scheduling/programs?tenantId=xxx&programId=yyy
   */
  @ApiMethod('DELETE')
  async delete(event: any) {
    console.log('[ProgramsService] DELETE - Deleting program');
    
    const tenantId = getTenantId(event);
    const programId = event.queryStringParameters?.programId;

    if (!tenantId || !programId) {
      return error(400, 'Missing tenantId or programId');
    }

    try {
      // Check if exists
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE,
        Key: { tenantId, programId },
      }));

      if (!existing.Item) {
        return error(404, 'Program not found');
      }

      await docClient.send(new DeleteCommand({
        TableName: TABLE,
        Key: { tenantId, programId },
      }));

      console.log('[ProgramsService] Deleted program:', programId);
      return success({ deleted: true, programId });
    } catch (err: any) {
      console.error('[ProgramsService] DELETE error:', err);
      return error(500, err.message);
    }
  }
}

// Export individual handlers for Lambda (one Lambda per method)
const service = new ProgramsService();
export const get = (event: any) => service.get(event);
export const create = (event: any) => service.create(event);
export const update = (event: any) => service.update(event);

// Alias delete since it's a reserved keyword
const deleteHandler = (event: any) => service.delete(event);
export { deleteHandler as delete };
