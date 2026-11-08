import crypto from "crypto";
import { storage } from "../storage.js";
import { db } from "../db.js";
import { webhooks, webhookLogs } from "../../shared/schema.js";
import { eq, and } from "drizzle-orm";
import { validateWebhookUrl } from "../utils/url-validator.js";
const RETRY_DELAYS = [0, 6e4, 3e5];
class WebhookDeliveryService {
  generateSignature(payload, secret) {
    return crypto.createHmac("sha256", secret).update(payload).digest("hex");
  }
  buildHeaders(webhook, payloadString) {
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "Platform-Webhook/1.0",
      "X-Webhook-Event": webhook.events?.[0] || "unknown",
      "X-Webhook-Delivery": crypto.randomUUID(),
      "X-Webhook-Signature": `sha256=${this.generateSignature(payloadString, webhook.secret)}`
    };
    if (webhook.authType === "basic" && webhook.authCredentials) {
      const creds = webhook.authCredentials;
      if (creds.username && creds.password) {
        const basicAuth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
        headers["Authorization"] = `Basic ${basicAuth}`;
      }
    } else if (webhook.authType === "bearer" && webhook.authCredentials) {
      const creds = webhook.authCredentials;
      if (creds.token) {
        headers["Authorization"] = `Bearer ${creds.token}`;
      }
    }
    if (webhook.headers) {
      const customHeaders = webhook.headers;
      Object.assign(headers, customHeaders);
    }
    return headers;
  }
  async deliverWebhook(webhook, payload, attemptNumber = 1) {
    const payloadString = JSON.stringify(payload);
    const headers = this.buildHeaders(webhook, payloadString);
    const startTime = Date.now();
    console.log(`\u{1F4E4} [Webhook] Delivering to ${webhook.url} (attempt ${attemptNumber})`);
    console.log(`   Event: ${payload.event}`);
    try {
      const urlCheck = await validateWebhookUrl(webhook.url);
      if (!urlCheck.valid) {
        console.warn(`\u{1F6AB} [Webhook] SSRF blocked: ${urlCheck.error} for URL ${webhook.url}`);
        return {
          success: false,
          httpStatus: 0,
          responseBody: `Blocked: ${urlCheck.error}`,
          responseTime: 0,
          error: urlCheck.error
        };
      }
      const response = await fetch(webhook.url, {
        method: webhook.method || "POST",
        headers,
        body: payloadString,
        signal: AbortSignal.timeout(3e4),
        redirect: "error"
      });
      const responseTime = Date.now() - startTime;
      let responseBody = "";
      try {
        responseBody = await response.text();
        if (responseBody.length > 1e4) {
          responseBody = responseBody.substring(0, 1e4) + "...[truncated]";
        }
      } catch {
        responseBody = "Unable to read response body";
      }
      const success = response.ok;
      console.log(`${success ? "\u2705" : "\u274C"} [Webhook] Status: ${response.status}, Time: ${responseTime}ms`);
      return {
        success,
        httpStatus: response.status,
        responseBody,
        responseTime
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage = error.name === "TimeoutError" ? "Request timed out after 30 seconds" : error.message || "Unknown error";
      console.error(`\u274C [Webhook] Delivery failed: ${errorMessage}`);
      return {
        success: false,
        responseTime,
        error: errorMessage
      };
    }
  }
  async deliverWithRetry(webhook, payload, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.deliverWebhook(webhook, payload, attempt);
      const logData = {
        webhookId: webhook.id,
        event: payload.event,
        payload,
        success: result.success,
        httpStatus: result.httpStatus || null,
        responseBody: result.responseBody || null,
        responseTime: result.responseTime || null,
        error: result.error || null,
        attemptNumber: attempt,
        maxAttempts,
        nextRetryAt: null
      };
      if (!result.success && attempt < maxAttempts) {
        const delay = RETRY_DELAYS[attempt] || 3e5;
        logData.nextRetryAt = new Date(Date.now() + delay);
        console.log(`\u23F3 [Webhook] Scheduling retry in ${delay / 1e3}s`);
      }
      try {
        const webhookExists = await storage.getWebhook(webhook.id);
        if (webhookExists) {
          await storage.createWebhookLog(logData);
        } else {
          console.log(`\u2139\uFE0F [Webhook] Skipping log - webhook ${webhook.id} was deleted`);
        }
      } catch (err) {
        if (err.code === "23503" || err.message?.includes("foreign key constraint")) {
          console.log(`\u2139\uFE0F [Webhook] Skipping log - webhook ${webhook.id} no longer exists`);
        } else {
          console.error(`\u274C [Webhook] Failed to log delivery:`, err);
        }
      }
      if (result.success) {
        console.log(`\u2705 [Webhook] Delivery successful on attempt ${attempt}`);
        return;
      }
      if (attempt < maxAttempts) {
        const delay = RETRY_DELAYS[attempt] || 6e4;
        console.log(`\u23F3 [Webhook] Waiting ${delay / 1e3}s before retry...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    console.error(`\u274C [Webhook] All ${maxAttempts} attempts failed for ${webhook.url}`);
  }
  async triggerEvent(userId, event, data, campaignId) {
    console.log(`\u{1F514} [Webhook] Triggering event: ${event}`);
    console.log(`   UserId: ${userId}, CampaignId: ${campaignId || "N/A"}`);
    try {
      const webhooks2 = await storage.getWebhooksForEvent(userId, event, campaignId || void 0);
      if (webhooks2.length === 0) {
        console.log(`\u2139\uFE0F [Webhook] No webhooks configured for event: ${event}`);
        return;
      }
      console.log(`\u{1F4E4} [Webhook] Found ${webhooks2.length} webhook(s) to deliver`);
      const payload = {
        event,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        data
      };
      const deliveryPromises = webhooks2.map(
        (webhook) => this.deliverWithRetry(webhook, payload).catch((err) => {
          console.error(`\u274C [Webhook] Error delivering to ${webhook.url}:`, err);
        })
      );
      await Promise.allSettled(deliveryPromises);
      console.log(`\u2705 [Webhook] Event ${event} processing complete`);
    } catch (error) {
      console.error(`\u274C [Webhook] Error triggering event ${event}:`, error);
    }
  }
  async testWebhook(webhookId, userId) {
    const [webhook] = await db.select().from(webhooks).where(and(eq(webhooks.id, webhookId), eq(webhooks.userId, userId)));
    if (!webhook) {
      throw new Error("Webhook not found");
    }
    const testPayload = {
      event: "webhook.test",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      data: {
        test: true,
        message: "This is a test webhook from your platform"
      }
    };
    console.log(`\u{1F9EA} Testing webhook ${webhookId}...`);
    const result = await this.deliverWebhook(webhook, testPayload, 1);
    return {
      success: result.success,
      statusCode: result.httpStatus || 0,
      responseTime: result.responseTime || 0,
      responseBody: result.responseBody || "",
      error: result.error
    };
  }
  async retryWebhook(logId, userId) {
    const [log] = await db.select().from(webhookLogs).where(eq(webhookLogs.id, logId));
    if (!log) {
      throw new Error("Webhook log not found");
    }
    const [webhook] = await db.select().from(webhooks).where(and(eq(webhooks.id, log.webhookId), eq(webhooks.userId, userId)));
    if (!webhook) {
      throw new Error("Webhook not found or access denied");
    }
    console.log(`\u{1F504} Manually retrying webhook ${webhook.id} (log ${logId})...`);
    const payload = {
      event: log.event,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      data: log.payload?.data || log.payload
    };
    const result = await this.deliverWebhook(webhook, payload, 1);
    const logData = {
      webhookId: webhook.id,
      event: log.event,
      payload: log.payload,
      success: result.success,
      httpStatus: result.httpStatus || null,
      responseBody: result.responseBody || null,
      responseTime: result.responseTime || null,
      error: result.error || null,
      attemptNumber: 1,
      maxAttempts: 1,
      nextRetryAt: null
    };
    try {
      const newLog = await storage.createWebhookLog(logData);
      return {
        success: result.success,
        newLogId: newLog?.id,
        error: result.error
      };
    } catch (err) {
      console.error(`\u274C [Webhook] Failed to log retry:`, err);
      return {
        success: result.success,
        error: result.error
      };
    }
  }
}
const webhookDeliveryService = new WebhookDeliveryService();
export {
  WebhookDeliveryService,
  webhookDeliveryService
};
