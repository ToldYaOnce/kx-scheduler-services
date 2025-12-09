/**
 * Kx Scheduling Engine - Domain Models
 * 
 * These interfaces define the core entities for the multi-tenant scheduling system.
 * The engine is product-agnostic and can be used for gyms, salons, clinics, etc.
 */

// =============================================================================
// Host Reference (providers/resources)
// =============================================================================

export interface HostRef {
  /** ID of the host (instructorId, doctorId, stylistId, roomId, etc.) */
  id: string;
  /** Type of host: "INSTRUCTOR" | "COACH" | "DOCTOR" | "STYLIST" | "ROOM" | "RESOURCE" | etc. */
  type: string;
  /** Optional role: "LEAD" | "ASSISTANT" | "TRAINEE" etc. */
  role?: string;
}

// =============================================================================
// Program
// =============================================================================

export interface Program {
  tenantId: string;
  programId: string;
  name: string;
  description?: string;
  defaultDurationMinutes?: number;
  tags?: string[]; // e.g. ["yoga", "beginner", "fat-loss"]
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Location (with GPS)
// =============================================================================

export interface Location {
  tenantId: string;
  locationId: string;
  name: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  lat?: number;
  lng?: number;
  checkInRadiusMeters?: number; // e.g. 100m
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Schedule
// =============================================================================

export type ScheduleType = "SESSION" | "BLOCK";

export interface Schedule {
  tenantId: string;
  scheduleId: string;
  /** "SESSION" = bookable, "BLOCK" = host unavailable */
  type: ScheduleType;
  /** null/undefined for BLOCKs */
  programId?: string;
  /** ISO-8601 - Time of the first instance */
  start: string;
  /** ISO-8601 - End time of the first instance */
  end: string;
  /** IANA timezone, e.g. "America/New_York" */
  timezone: string;
  isRecurring: boolean;
  /** RFC5545 RRULE (constrained: DAILY, WEEKLY+BYDAY, MONTHLY simple) */
  rrule?: string;
  /** Required for type="SESSION"; ignored for BLOCK */
  baseCapacity?: number;
  hosts?: HostRef[];
  locationId?: string;
  tags?: string[];
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Schedule Exception
// =============================================================================

export type ScheduleExceptionType = "CANCELLED" | "OVERRIDE";

export interface ScheduleException {
  tenantId: string;
  scheduleId: string;
  /** Local date in schedule timezone: "YYYY-MM-DD" */
  occurrenceDate: string;
  type: ScheduleExceptionType;
  /** Only used when type="OVERRIDE" */
  overrideStart?: string;
  overrideEnd?: string;
  overrideCapacity?: number;
  overrideHosts?: HostRef[];
  overrideLocationId?: string;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Session (Virtual/Computed - NOT stored)
// =============================================================================

export interface Session {
  tenantId: string;
  /** Format: `${scheduleId}#${occurrenceDate}` */
  sessionId: string;
  scheduleId: string;
  programId?: string;
  type: ScheduleType;
  /** Local date "YYYY-MM-DD" */
  date: string;
  /** ISO-8601 start datetime */
  start: string;
  /** ISO-8601 end datetime */
  end: string;
  timezone: string;
  hosts?: HostRef[];
  locationId?: string;
  tags?: string[];
  /** Resolved from baseCapacity/overrideCapacity for SESSION */
  capacity?: number;
  /** From SessionSummary */
  bookedCount?: number;
  /** From SessionSummary */
  waitlistCount?: number;
}

// =============================================================================
// Session Summary (stored for capacity tracking)
// =============================================================================

export interface SessionSummary {
  tenantId: string;
  /** Format: `${scheduleId}#${date}` */
  sessionId: string;
  scheduleId: string;
  date: string;
  start: string;
  end: string;
  /** Resolved final capacity for this session */
  capacity: number;
  /** CONFIRMED bookings count */
  bookedCount: number;
  /** WAITLIST bookings count (optional v1; can be 0) */
  waitlistCount: number;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Booking
// =============================================================================

export type BookingStatus = "CONFIRMED" | "CANCELLED" | "WAITLIST";

export interface Booking {
  tenantId: string;
  sessionId: string;
  bookingId: string;
  /** leadId, memberId, patientId, generic userId, etc. */
  subjectId: string;
  /** "LEAD" | "MEMBER" | "PATIENT" | "CLIENT" | etc. */
  subjectType: string;
  status: BookingStatus;
  createdAt: string;
  cancelledAt?: string;
  /** Source of booking (web, app, phone, etc.) */
  source?: string;
  notes?: string;
}

// =============================================================================
// Attendance Record
// =============================================================================

export type AttendanceStatus = "PRESENT" | "LATE" | "NO_SHOW";
export type CheckInMethod = "GPS" | "MANUAL" | "OVERRIDE";

export interface AttendanceRecord {
  tenantId: string;
  sessionId: string;
  bookingId: string;
  subjectId: string;
  subjectType: string;
  status: AttendanceStatus;
  /** ISO-8601 */
  checkInTime?: string;
  checkInMethod?: CheckInMethod;
  checkInLat?: number;
  checkInLng?: number;
  createdAt: string;
  updatedAt: string;
}


