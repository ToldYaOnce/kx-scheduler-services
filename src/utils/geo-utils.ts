/**
 * Geo Utilities for GPS-based Attendance Check-in
 * 
 * Uses the Haversine formula to calculate distances between GPS coordinates.
 */

/**
 * Earth's radius in meters
 */
const EARTH_RADIUS_METERS = 6371000;

/**
 * Convert degrees to radians
 */
function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Calculate the distance between two GPS coordinates using the Haversine formula
 * 
 * @param lat1 - Latitude of point 1
 * @param lng1 - Longitude of point 1
 * @param lat2 - Latitude of point 2
 * @param lng2 - Longitude of point 2
 * @returns Distance in meters
 */
export function calculateDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
    Math.cos(toRadians(lat2)) *
    Math.sin(dLng / 2) *
    Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

/**
 * Check if a point is within a radius of another point
 * 
 * @param checkLat - Latitude of the point to check
 * @param checkLng - Longitude of the point to check
 * @param centerLat - Latitude of the center point
 * @param centerLng - Longitude of the center point
 * @param radiusMeters - Radius in meters
 * @returns true if within radius, false otherwise
 */
export function isWithinRadius(
  checkLat: number,
  checkLng: number,
  centerLat: number,
  centerLng: number,
  radiusMeters: number
): boolean {
  const distance = calculateDistance(checkLat, checkLng, centerLat, centerLng);
  return distance <= radiusMeters;
}

/**
 * Default check-in radius in meters (100m)
 */
export const DEFAULT_CHECK_IN_RADIUS_METERS = 100;

/**
 * Validate GPS coordinates
 * 
 * @param lat - Latitude (-90 to 90)
 * @param lng - Longitude (-180 to 180)
 * @returns true if valid, false otherwise
 */
export function isValidCoordinates(lat: number, lng: number): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    !isNaN(lat) &&
    !isNaN(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Result of a GPS check-in validation
 */
export interface CheckInValidation {
  /** Whether the check-in location is valid */
  valid: boolean;
  /** Distance from the location center in meters */
  distanceMeters: number;
  /** The required radius in meters */
  requiredRadiusMeters: number;
  /** Human-readable message */
  message: string;
}

/**
 * Validate a GPS check-in against a location
 * 
 * @param checkInLat - Check-in latitude
 * @param checkInLng - Check-in longitude
 * @param locationLat - Location center latitude
 * @param locationLng - Location center longitude
 * @param radiusMeters - Allowed radius in meters (default: 100m)
 * @returns CheckInValidation result
 */
export function validateCheckIn(
  checkInLat: number,
  checkInLng: number,
  locationLat: number,
  locationLng: number,
  radiusMeters: number = DEFAULT_CHECK_IN_RADIUS_METERS
): CheckInValidation {
  // Validate coordinates
  if (!isValidCoordinates(checkInLat, checkInLng)) {
    return {
      valid: false,
      distanceMeters: -1,
      requiredRadiusMeters: radiusMeters,
      message: 'Invalid check-in coordinates',
    };
  }

  if (!isValidCoordinates(locationLat, locationLng)) {
    return {
      valid: false,
      distanceMeters: -1,
      requiredRadiusMeters: radiusMeters,
      message: 'Invalid location coordinates',
    };
  }

  const distance = calculateDistance(checkInLat, checkInLng, locationLat, locationLng);
  const valid = distance <= radiusMeters;

  return {
    valid,
    distanceMeters: Math.round(distance),
    requiredRadiusMeters: radiusMeters,
    message: valid
      ? `Check-in successful (${Math.round(distance)}m from location)`
      : `Too far from location (${Math.round(distance)}m, max ${radiusMeters}m)`,
  };
}

/**
 * Check-in time window validation
 */
export interface TimeWindowValidation {
  /** Whether the check-in time is within the allowed window */
  valid: boolean;
  /** Minutes before/after the session start (negative = before) */
  minutesFromStart: number;
  /** Human-readable message */
  message: string;
}

/**
 * Validate check-in time against session time window
 * 
 * Default window: 15 minutes before to 15 minutes after session start
 * 
 * @param checkInTime - Check-in time (ISO string or Date)
 * @param sessionStart - Session start time (ISO string or Date)
 * @param windowMinutesBefore - Minutes allowed before session start (default: 15)
 * @param windowMinutesAfter - Minutes allowed after session start (default: 15)
 * @returns TimeWindowValidation result
 */
export function validateCheckInTime(
  checkInTime: string | Date,
  sessionStart: string | Date,
  windowMinutesBefore: number = 15,
  windowMinutesAfter: number = 15
): TimeWindowValidation {
  const checkIn = new Date(checkInTime);
  const start = new Date(sessionStart);

  const diffMs = checkIn.getTime() - start.getTime();
  const diffMinutes = diffMs / (1000 * 60);

  const windowStart = -windowMinutesBefore;
  const windowEnd = windowMinutesAfter;

  const valid = diffMinutes >= windowStart && diffMinutes <= windowEnd;

  let message: string;
  if (diffMinutes < windowStart) {
    message = `Too early to check in (${Math.abs(Math.round(diffMinutes))} minutes before session, window opens ${windowMinutesBefore} minutes before)`;
  } else if (diffMinutes > windowEnd) {
    message = `Too late to check in (${Math.round(diffMinutes)} minutes after session start, window closed ${windowMinutesAfter} minutes after)`;
  } else {
    message = `Check-in time valid`;
  }

  return {
    valid,
    minutesFromStart: Math.round(diffMinutes),
    message,
  };
}




