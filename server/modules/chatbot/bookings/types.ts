/**
 * Domain types for the chatbot bookings slice. Ported from the Commerce Crew chatbot-booking extension
 * (ext_chatbot_calendars, ext_chatbot_appointments, ext_chatbot_booking_reminders). No runtime imports
 * except the constant arrays below.
 */

export const APPOINTMENT_STATUSES = ["confirmed", "waitlisted", "cancelled"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const REMINDER_CHANNELS = ["email", "sms", "whatsapp", "telegram", "web"] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

export const REMINDER_STATUSES = ["queued", "sent", "failed", "cancelled"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Working hours for one weekday in the calendar's own timezone. Times are "HH:MM", 24-hour. */
export interface DayHours {
  enabled: boolean;
  start: string;
  end: string;
}

/** Same shape as the Desk appointment_settings.working_hours column (shared/schema.ts). */
export type WeeklyAvailability = Partial<Record<Weekday, DayHours>>;

export interface CalendarRecord {
  id: string;
  companyId: string;
  name: string;
  timezone: string;
  availability: WeeklyAvailability | null;
  /** Minimum gap in minutes between two confirmed appointments on this calendar. */
  bufferMinutes: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewCalendar {
  name: string;
  timezone: string;
  availability: WeeklyAvailability | null;
  bufferMinutes: number;
}

export interface AppointmentRecord {
  id: string;
  companyId: string;
  calendarId: string;
  conversationId: string | null;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  statusReason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewAppointment {
  calendarId: string;
  conversationId: string | null;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  metadata: Record<string, unknown> | null;
}

export interface ReminderRecord {
  id: string;
  companyId: string;
  appointmentId: string;
  channel: ReminderChannel;
  sendAt: Date;
  status: ReminderStatus;
  createdAt: Date;
}

export interface NewReminder {
  appointmentId: string;
  channel: ReminderChannel;
  sendAt: Date;
}

export interface Interval {
  start: Date;
  end: Date;
}
