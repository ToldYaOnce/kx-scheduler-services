/**
 * Locations Service
 * 
 * CRUD operations for Locations (physical places with GPS).
 * API Base Path: /scheduling/locations
 */

import { ApiBasePath, ApiMethod } from '@toldyaonce/kx-cdk-lambda-utils';
import { getApiMethodHandlers } from '@toldyaonce/kx-cdk-lambda-utils/wrappers/rest-service';
import { Location } from '../domain/models';
import { isValidCoordinates, DEFAULT_CHECK_IN_RADIUS_METERS } from '../utils/geo-utils';
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

const TABLE = process.env.LOCATIONS_TABLE!;

/**
 * Locations Service
 */
@ApiBasePath('/scheduling/locations')
export class LocationsService {

  @ApiMethod('GET')
  async get(event: any) {
    console.log('[LocationsService] GET - Fetching locations');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    const locationId = event.queryStringParameters?.locationId;

    try {
      if (locationId) {
        const result = await docClient.send(new GetCommand({
          TableName: TABLE,
          Key: { tenantId, locationId },
        }));
        
        if (!result.Item) {
          return error(404, 'Location not found');
        }
        return success(result.Item);
      }

      const result = await docClient.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'tenantId = :tenantId',
        ExpressionAttributeValues: { ':tenantId': tenantId },
      }));

      return success(result.Items || []);
    } catch (err: any) {
      console.error('[LocationsService] GET error:', err);
      return error(500, err.message);
    }
  }

  @ApiMethod('POST')
  async create(event: any) {
    console.log('[LocationsService] POST - Creating location');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    try {
      const body = parseBody(event);
      
      if (!body.name) {
        return error(400, 'Missing required field: name');
      }

      // Validate GPS if provided
      if (body.lat !== undefined || body.lng !== undefined) {
        if (!isValidCoordinates(body.lat, body.lng)) {
          return error(400, 'Invalid GPS coordinates');
        }
      }

      const timestamp = now();
      const location: Location = {
        ...body,  // Accept any fields
        tenantId,
        locationId: body.locationId || generateId('loc'),
        checkInRadiusMeters: body.checkInRadiusMeters ?? DEFAULT_CHECK_IN_RADIUS_METERS,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await docClient.send(new PutCommand({
        TableName: TABLE,
        Item: location,
      }));

      console.log('[LocationsService] Created location:', location.locationId);
      return success(location, 201);
    } catch (err: any) {
      console.error('[LocationsService] POST error:', err);
      return error(500, err.message);
    }
  }

  @ApiMethod('PATCH')
  async update(event: any) {
    console.log('[LocationsService] PATCH - Updating location');
    
    const tenantId = getTenantId(event);
    if (!tenantId) {
      return error(400, 'Missing tenantId');
    }

    try {
      const body = parseBody(event);
      
      if (!body.locationId) {
        return error(400, 'Missing locationId in body');
      }

      const existing = await docClient.send(new GetCommand({
        TableName: TABLE,
        Key: { tenantId, locationId: body.locationId },
      }));

      if (!existing.Item) {
        return error(404, 'Location not found');
      }

      // Validate GPS if being updated
      const newLat = body.lat ?? existing.Item.lat;
      const newLng = body.lng ?? existing.Item.lng;
      if ((newLat !== undefined || newLng !== undefined) && !isValidCoordinates(newLat, newLng)) {
        return error(400, 'Invalid GPS coordinates');
      }

      const current = existing.Item as Location;
      const updated: Location = {
        ...current,
        ...body,
        tenantId: current.tenantId,
        locationId: current.locationId,
        createdAt: current.createdAt,
        updatedAt: now(),
      };

      await docClient.send(new PutCommand({
        TableName: TABLE,
        Item: updated,
      }));

      console.log('[LocationsService] Updated location:', body.locationId);
      return success(updated);
    } catch (err: any) {
      console.error('[LocationsService] PATCH error:', err);
      return error(500, err.message);
    }
  }

  @ApiMethod('DELETE')
  async delete(event: any) {
    console.log('[LocationsService] DELETE - Deleting location');
    
    const tenantId = getTenantId(event);
    const locationId = event.queryStringParameters?.locationId;

    if (!tenantId || !locationId) {
      return error(400, 'Missing tenantId or locationId');
    }

    try {
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE,
        Key: { tenantId, locationId },
      }));

      if (!existing.Item) {
        return error(404, 'Location not found');
      }

      await docClient.send(new DeleteCommand({
        TableName: TABLE,
        Key: { tenantId, locationId },
      }));

      console.log('[LocationsService] Deleted location:', locationId);
      return success({ deleted: true, locationId });
    } catch (err: any) {
      console.error('[LocationsService] DELETE error:', err);
      return error(500, err.message);
    }
  }
}

// Export individual handlers for Lambda
const service = new LocationsService();
export const get = (event: any) => service.get(event);
export const create = (event: any) => service.create(event);
export const update = (event: any) => service.update(event);
const deleteHandler = (event: any) => service.delete(event);
export { deleteHandler as delete };
