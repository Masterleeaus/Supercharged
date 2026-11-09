/** Appointment CRUD, appointment settings and calendar sync routes. */
import { Router, Response } from "express";
import { db } from "../../db";
import { type AuthRequest } from "../../middleware/auth";
import { getCompanyScope } from "../../middleware/company-scope";
import { webhooks, appointments, createAppointmentSchema, appointmentSettings, agents } from "@shared/schema";
import { eq, and, or, gte, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { webhookDeliveryService } from "../../services/webhook-delivery";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from "../../services/google-calendar/google-calendar.service";
import { logger } from "../../utils/logger";
import { companyForRead, APPOINTMENT_EDITABLE_FIELDS, pickEditableFields, validateWorkingHours } from "./shared";

export function registerAppointmentRoutes(router: Router): void {
  router.get("/appointments", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { startDate, endDate, status } = req.query;

      const conditions: any[] = [eq(appointments.userId, userId), eq(appointments.companyId, companyId)];

      if (startDate && typeof startDate === 'string') {
        const parsedStartDate = new Date(startDate);
        if (!isNaN(parsedStartDate.getTime())) {
          conditions.push(gte(appointments.appointmentDate, parsedStartDate.toISOString().split('T')[0]));
        }
      }
      if (endDate && typeof endDate === 'string') {
        const parsedEndDate = new Date(endDate);
        if (!isNaN(parsedEndDate.getTime())) {
          conditions.push(lte(appointments.appointmentDate, parsedEndDate.toISOString().split('T')[0]));
        }
      }
      if (status) {
        conditions.push(eq(appointments.status, status as string));
      }

      const result = await db
        .select()
        .from(appointments)
        .where(and(...conditions))
        .orderBy(appointments.appointmentDate, appointments.appointmentTime);

      const appointmentsWithScheduledFor = result.map(apt => ({
        ...apt,
        scheduledFor: `${apt.appointmentDate}T${apt.appointmentTime}`,
      }));

      res.json(appointmentsWithScheduledFor);
    } catch (error: any) {
      logger.error("Error fetching appointments:", error);
      res.status(500).json({ error: "Failed to fetch appointments" });
    }
  });

  router.post("/appointments", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const validatedData = createAppointmentSchema.parse(req.body);

      let companyId: string;
      try {
        companyId = getCompanyScope(req);
      } catch {
        return res.status(403).json({ error: "Company scope required" });
      }

      // Validate working hours
      const workingHoursResult = await validateWorkingHours(
        userId,
        companyId,
        validatedData.appointmentDate,
        validatedData.appointmentTime,
        validatedData.duration || 30
      );

      if (!workingHoursResult.valid) {
        return res.status(400).json({ error: workingHoursResult.message });
      }

      const [settings] = await db
        .select()
        .from(appointmentSettings)
        .where(and(eq(appointmentSettings.userId, userId), eq(appointmentSettings.companyId, companyId)));

      if (settings && !settings.allowOverlapping) {
        const existing = await db
          .select()
          .from(appointments)
          .where(
            and(
              eq(appointments.userId, userId),
              eq(appointments.companyId, companyId),
              eq(appointments.appointmentDate, validatedData.appointmentDate),
              eq(appointments.appointmentTime, validatedData.appointmentTime),
              eq(appointments.status, "scheduled")
            )
          );

        if (existing.length > 0) {
          return res.status(409).json({
            error: "Appointment slot already booked",
            conflictingAppointment: existing[0]
          });
        }
      }

      const appointmentId = nanoid();
      const [newAppointment] = await db
        .insert(appointments)
        .values({
          id: appointmentId,
          userId,
          ...validatedData,
          companyId,
        })
        .returning();

      res.json(newAppointment);
    } catch (error: any) {
      logger.error("Error creating appointment:", error);
      res.status(500).json({ error: "Failed to create appointment" });
    }
  });

  router.patch("/appointments/:id", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const { id } = req.params;

      const companyId = companyForRead(req, res);
      if (!companyId) return;

      const editable = pickEditableFields(req.body, APPOINTMENT_EDITABLE_FIELDS);
      if (!editable) {
        return res.status(400).json({ error: "No editable fields in request body" });
      }

      // Fetch the original appointment to detect changes
      const [originalAppointment] = await db
        .select()
        .from(appointments)
        .where(and(eq(appointments.id, id), eq(appointments.userId, userId), eq(appointments.companyId, companyId)));

      if (!originalAppointment) {
        return res.status(404).json({ error: "Appointment not found" });
      }

      const [updatedAppointment] = await db
        .update(appointments)
        .set({
          ...editable,
          updatedAt: new Date(),
        })
        .where(and(eq(appointments.id, id), eq(appointments.userId, userId)))
        .returning();

      if (!updatedAppointment) {
        return res.status(404).json({ error: "Appointment not found" });
      }

      // Build common webhook payload
      const buildAppointmentPayload = (apt: typeof updatedAppointment) => ({
        appointmentId: apt.id,
        contactName: apt.contactName || null,
        contactPhone: apt.contactPhone || null,
        contactEmail: apt.contactEmail || null,
        date: apt.appointmentDate,
        time: apt.appointmentTime,
        duration: apt.duration || 30,
        serviceName: apt.serviceName || null,
        notes: apt.notes || null,
        status: apt.status,
        flowId: apt.flowId || null,
        callId: apt.callId || null,
      });

      // Trigger webhook events based on status changes
      const oldStatus = originalAppointment.status;
      const newStatus = updatedAppointment.status;
      const oldDate = originalAppointment.appointmentDate;
      const oldTime = originalAppointment.appointmentTime;
      const newDate = updatedAppointment.appointmentDate;
      const newTime = updatedAppointment.appointmentTime;

      // Check for reschedule (date or time changed)
      if ((oldDate !== newDate || oldTime !== newTime) && newStatus !== 'cancelled') {
        try {
          await webhookDeliveryService.triggerEvent(companyId, userId, 'appointment.rescheduled', {
            appointment: buildAppointmentPayload(updatedAppointment),
            previousDate: oldDate,
            previousTime: oldTime,
            newDate: newDate,
            newTime: newTime,
            rescheduledAt: new Date().toISOString(),
          });
          logger.info(`📅 [Appointment Webhook] Triggered appointment.rescheduled for ${id}`);
        } catch (webhookError: any) {
          logger.error(`📅 [Appointment Webhook] Failed to trigger rescheduled webhook:`, webhookError.message);
        }
      }

      // Check for status changes and trigger corresponding webhooks
      if (oldStatus !== newStatus) {
        try {
          switch (newStatus) {
            case 'confirmed':
              await webhookDeliveryService.triggerEvent(companyId, userId, 'appointment.confirmed', {
                appointment: buildAppointmentPayload(updatedAppointment),
                confirmedAt: new Date().toISOString(),
              });
              logger.info(`📅 [Appointment Webhook] Triggered appointment.confirmed for ${id}`);
              break;

            case 'cancelled':
              await webhookDeliveryService.triggerEvent(companyId, userId, 'appointment.cancelled', {
                appointment: buildAppointmentPayload(updatedAppointment),
                cancelReason: req.body.cancelReason || null,
                cancelledAt: new Date().toISOString(),
              });
              logger.info(`📅 [Appointment Webhook] Triggered appointment.cancelled for ${id}`);
              break;

            case 'completed':
              await webhookDeliveryService.triggerEvent(companyId, userId, 'appointment.completed', {
                appointment: buildAppointmentPayload(updatedAppointment),
                completedAt: new Date().toISOString(),
              });
              logger.info(`📅 [Appointment Webhook] Triggered appointment.completed for ${id}`);
              break;

            case 'no_show':
            case 'noshow':
            case 'no-show':
              await webhookDeliveryService.triggerEvent(companyId, userId, 'appointment.no_show', {
                appointment: buildAppointmentPayload(updatedAppointment),
                markedNoShowAt: new Date().toISOString(),
              });
              logger.info(`📅 [Appointment Webhook] Triggered appointment.no_show for ${id}`);
              break;
          }
        } catch (webhookError: any) {
          logger.error(`📅 [Appointment Webhook] Failed to trigger ${newStatus} webhook:`, webhookError.message);
        }
      }

      // Sync to Google Calendar if connected
      try {
        const calendarApt = {
          id: updatedAppointment.id,
          contactName: updatedAppointment.contactName,
          contactPhone: updatedAppointment.contactPhone,
          contactEmail: updatedAppointment.contactEmail,
          appointmentDate: updatedAppointment.appointmentDate,
          appointmentTime: updatedAppointment.appointmentTime,
          duration: updatedAppointment.duration,
          serviceName: updatedAppointment.serviceName,
          notes: updatedAppointment.notes,
          status: updatedAppointment.status,
        };
        const existingEventId = updatedAppointment.googleCalendarEventId;

        if (updatedAppointment.status === "cancelled" && existingEventId) {
          const deleted = await deleteCalendarEvent(userId, existingEventId);
          if (deleted) {
            await db.update(appointments)
              .set({ googleCalendarEventId: null, updatedAt: new Date() })
              .where(eq(appointments.id, id));
          } else {
            logger.warn(`[GoogleCalendar] Delete failed for event ${existingEventId} on cancel — keeping ID for retry`);
          }
        } else if (existingEventId) {
          await updateCalendarEvent(userId, existingEventId, calendarApt);
        }
      } catch (calErr: any) {
        logger.error(`📅 [GoogleCalendar] Sync error on PATCH for ${id}:`, calErr.message);
      }

      res.json({
        ...updatedAppointment,
        scheduledFor: `${updatedAppointment.appointmentDate}T${updatedAppointment.appointmentTime}`,
      });
    } catch (error: any) {
      logger.error("Error updating appointment:", error);
      res.status(500).json({ error: "Failed to update appointment" });
    }
  });

  router.post("/appointments/:id/sync-calendar", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) return res.status(401).json({ error: "Unauthorized" });
      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { id } = req.params;

      const [apt] = await db.select().from(appointments)
        .where(and(eq(appointments.id, id), eq(appointments.userId, userId), eq(appointments.companyId, companyId)));
      if (!apt) return res.status(404).json({ error: "Appointment not found" });

      const calendarApt = {
        id: apt.id,
        contactName: apt.contactName,
        contactPhone: apt.contactPhone,
        contactEmail: apt.contactEmail,
        appointmentDate: apt.appointmentDate,
        appointmentTime: apt.appointmentTime,
        duration: apt.duration,
        serviceName: apt.serviceName,
        notes: apt.notes,
        status: apt.status,
      };

      let eventId = apt.googleCalendarEventId;
      if (eventId) {
        await updateCalendarEvent(userId, eventId, calendarApt);
      } else {
        eventId = await createCalendarEvent(userId, calendarApt);
        if (eventId) {
          await db.update(appointments)
            .set({ googleCalendarEventId: eventId, updatedAt: new Date() })
            .where(eq(appointments.id, id));
        }
      }

      if (!eventId) {
        return res.status(502).json({ error: "Failed to sync to Google Calendar. Please check your connection." });
      }

      const [updated] = await db.select().from(appointments).where(and(eq(appointments.id, id), eq(appointments.userId, userId), eq(appointments.companyId, companyId)));
      res.json({
        ...updated,
        scheduledFor: `${updated.appointmentDate}T${updated.appointmentTime}`,
      });
    } catch (error: any) {
      logger.error("Error syncing appointment to calendar:", error);
      res.status(500).json({ error: "Failed to sync to Google Calendar" });
    }
  });

  router.delete("/appointments/:id", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const { id } = req.params;

      const companyId = companyForRead(req, res);
      if (!companyId) return;

      // Fetch the appointment before deletion to trigger webhook
      const [appointmentToDelete] = await db
        .select()
        .from(appointments)
        .where(and(eq(appointments.id, id), eq(appointments.userId, userId), eq(appointments.companyId, companyId)));

      if (!appointmentToDelete) {
        return res.status(404).json({ error: "Appointment not found" });
      }

      // Trigger appointment.cancelled webhook before deletion
      try {
        await webhookDeliveryService.triggerEvent(companyId, userId, 'appointment.cancelled', {
          appointment: {
            appointmentId: appointmentToDelete.id,
            contactName: appointmentToDelete.contactName || null,
            contactPhone: appointmentToDelete.contactPhone || null,
            contactEmail: appointmentToDelete.contactEmail || null,
            date: appointmentToDelete.appointmentDate,
            time: appointmentToDelete.appointmentTime,
            duration: appointmentToDelete.duration || 30,
            serviceName: appointmentToDelete.serviceName || null,
            notes: appointmentToDelete.notes || null,
            status: 'cancelled',
            flowId: appointmentToDelete.flowId || null,
            callId: appointmentToDelete.callId || null,
          },
          cancelReason: 'deleted',
          cancelledAt: new Date().toISOString(),
        });
        logger.info(`📅 [Appointment Webhook] Triggered appointment.cancelled for deleted appointment ${id}`);
      } catch (webhookError: any) {
        logger.error(`📅 [Appointment Webhook] Failed to trigger cancelled webhook:`, webhookError.message);
      }

      await db
        .delete(appointments)
        .where(and(eq(appointments.id, id), eq(appointments.userId, userId)));

      res.json({ success: true });
    } catch (error: any) {
      logger.error("Error deleting appointment:", error);
      res.status(500).json({ error: "Failed to delete appointment" });
    }
  });

  router.get("/appointment-settings", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;

      const [settings] = await db
        .select()
        .from(appointmentSettings)
        .where(and(eq(appointmentSettings.userId, userId), eq(appointmentSettings.companyId, companyId)));

      // Convert database format to frontend format
      const convertToFrontendFormat = (workingHours: any) => {
        if (!workingHours) {
          return {
            workingHoursStart: "09:00",
            workingHoursEnd: "17:00",
            workingDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
          };
        }

        // Extract enabled days
        const enabledDays: string[] = [];
        let startTime = "09:00";
        let endTime = "17:00";

        const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        for (const day of days) {
          const daySettings = workingHours[day];
          if (daySettings?.enabled) {
            enabledDays.push(day);
            // Use the first enabled day's times as the global times
            if (startTime === "09:00" && daySettings.start) startTime = daySettings.start;
            if (endTime === "17:00" && daySettings.end) endTime = daySettings.end;
          }
        }

        return {
          workingHoursStart: startTime,
          workingHoursEnd: endTime,
          workingDays: enabledDays,
        };
      };

      if (!settings) {
        return res.json({
          id: null,
          allowOverlap: false,
          bufferTime: 15,
          maxPerDay: null,
          syncToGoogleCalendar: false,
          workingHoursStart: "09:00",
          workingHoursEnd: "17:00",
          workingDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
        });
      }

      // Convert to frontend format
      const frontendFormat = convertToFrontendFormat(settings.workingHours);

      res.json({
        id: settings.id,
        allowOverlap: settings.allowOverlapping,
        bufferTime: settings.bufferMinutes,
        maxPerDay: null,
        syncToGoogleCalendar: settings.syncToGoogleCalendar,
        ...frontendFormat,
        createdAt: settings.createdAt,
        updatedAt: settings.updatedAt,
      });
    } catch (error: any) {
      logger.error("Error fetching appointment settings:", error);
      res.status(500).json({ error: "Failed to fetch appointment settings" });
    }
  });

  router.put("/appointment-settings", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;

      // Accept frontend format and convert to database format
      const {
        allowOverlap,
        bufferTime,
        workingHoursStart,
        workingHoursEnd,
        workingDays,
        syncToGoogleCalendar,
        // Also accept direct database format fields
        allowOverlapping,
        bufferMinutes,
        workingHours
      } = req.body;

      // Convert frontend format to database format
      const convertToDbFormat = () => {
        const start = workingHoursStart || "09:00";
        const end = workingHoursEnd || "17:00";
        const days = workingDays || ["monday", "tuesday", "wednesday", "thursday", "friday"];

        const allDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        const result: Record<string, { start: string; end: string; enabled: boolean }> = {};

        for (const day of allDays) {
          result[day] = {
            start,
            end,
            enabled: days.includes(day),
          };
        }

        return result;
      };

      // Use provided workingHours object if given (direct database format), 
      // otherwise convert from frontend format
      const dbWorkingHours = workingHours || convertToDbFormat();
      const dbAllowOverlapping = allowOverlapping ?? allowOverlap ?? false;
      const dbBufferMinutes = bufferMinutes ?? bufferTime ?? 0;
      const dbSyncToGoogleCalendar = syncToGoogleCalendar ?? false;

      logger.info('📅 [Settings] Saving appointment settings:', {
        allowOverlapping: dbAllowOverlapping,
        bufferMinutes: dbBufferMinutes,
        workingDays: workingDays,
        workingHours: dbWorkingHours,
      });

      const [existing] = await db
        .select()
        .from(appointmentSettings)
        .where(and(eq(appointmentSettings.userId, userId), eq(appointmentSettings.companyId, companyId)));

      if (existing) {
        const [updated] = await db
          .update(appointmentSettings)
          .set({
            allowOverlapping: dbAllowOverlapping,
            bufferMinutes: dbBufferMinutes,
            syncToGoogleCalendar: dbSyncToGoogleCalendar,
            workingHours: dbWorkingHours,
            updatedAt: new Date(),
          })
          .where(and(eq(appointmentSettings.userId, userId), eq(appointmentSettings.companyId, companyId)))
          .returning();

        // Convert back to frontend format for response
        const frontendFormat = {
          id: updated.id,
          allowOverlap: updated.allowOverlapping,
          bufferTime: updated.bufferMinutes,
          syncToGoogleCalendar: updated.syncToGoogleCalendar,
          maxPerDay: null,
          workingHoursStart: workingHoursStart || "09:00",
          workingHoursEnd: workingHoursEnd || "17:00",
          workingDays: workingDays || ["monday", "tuesday", "wednesday", "thursday", "friday"],
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        };

        return res.json(frontendFormat);
      } else {
        const settingsId = nanoid();
        const [created] = await db
          .insert(appointmentSettings)
          .values({
            id: settingsId,
            userId,
            companyId,
            allowOverlapping: dbAllowOverlapping,
            bufferMinutes: dbBufferMinutes,
            syncToGoogleCalendar: dbSyncToGoogleCalendar,
            workingHours: dbWorkingHours,
          })
          .returning();

        // Convert back to frontend format for response
        const frontendFormat = {
          id: created.id,
          allowOverlap: created.allowOverlapping,
          bufferTime: created.bufferMinutes,
          syncToGoogleCalendar: created.syncToGoogleCalendar,
          maxPerDay: null,
          workingHoursStart: workingHoursStart || "09:00",
          workingHoursEnd: workingHoursEnd || "17:00",
          workingDays: workingDays || ["monday", "tuesday", "wednesday", "thursday", "friday"],
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        };

        return res.json(frontendFormat);
      }
    } catch (error: any) {
      logger.error("Error updating appointment settings:", error);
      res.status(500).json({ error: "Failed to update appointment" });
    }
  });

  router.post("/appointments/sync", async (req: AuthRequest, res: Response) => {
    try {
      const {
        agentId,
        callId,
        contactName,
        contactPhone,
        contactEmail,
        appointmentDate,
        appointmentTime,
        duration,
        serviceName,
        notes,
        metadata
      } = req.body;

      const companyId = companyForRead(req, res);
      if (!companyId) return;

      if (!agentId) {
        return res.status(400).json({ error: "agentId is required" });
      }
      if (!contactName || !contactPhone) {
        return res.status(400).json({ error: "contactName and contactPhone are required" });
      }
      if (!appointmentDate || !appointmentTime) {
        return res.status(400).json({ error: "appointmentDate and appointmentTime are required" });
      }

      const agent = await db
        .select({ userId: agents.userId, flowId: agents.flowId })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .limit(1);

      if (agent.length === 0) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const userId = agent[0].userId;
      const flowId = agent[0].flowId;

      // Validate working hours
      const workingHoursResult = await validateWorkingHours(
        userId,
        companyId,
        appointmentDate,
        appointmentTime,
        duration || 30
      );

      if (!workingHoursResult.valid) {
        logger.warn(`📅 [Appointment Sync] Rejected due to working hours: ${workingHoursResult.message}`);
        return res.status(400).json({
          success: false,
          error: workingHoursResult.message
        });
      }

      const appointmentId = nanoid();
      const [newAppointment] = await db
        .insert(appointments)
        .values({
          id: appointmentId,
          userId,
          companyId,
          callId: callId || null,
          flowId: flowId || null,
          contactName,
          contactPhone,
          contactEmail: contactEmail || null,
          appointmentDate,
          appointmentTime,
          duration: duration || 30,
          serviceName: serviceName || null,
          notes: notes || null,
          status: "scheduled",
          metadata: metadata || null,
        })
        .returning();

      logger.info(`📅 [Appointment Sync] Created appointment ${appointmentId} for agent ${agentId}`);
      logger.info(`   Contact: ${contactName} ([redacted])`);
      logger.info(`   Date/Time: ${appointmentDate} at ${appointmentTime}`);

      res.json({
        success: true,
        appointment: newAppointment,
      });
    } catch (error: any) {
      logger.error("Error syncing appointment:", error);
      res.status(500).json({ error: "Failed to sync appointment" });
    }
  });
}
