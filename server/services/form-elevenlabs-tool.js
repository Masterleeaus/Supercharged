import { getDomain } from "../utils/domain.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
let formWebhookSecret = null;
function getFormWebhookSecret() {
  if (!formWebhookSecret) {
    if (process.env.FORM_WEBHOOK_SECRET) {
      formWebhookSecret = process.env.FORM_WEBHOOK_SECRET;
    } else {
      const baseKey = process.env.JWT_SECRET || process.env.ELEVENLABS_AGENT_SECRET;
      if (baseKey) {
        formWebhookSecret = crypto.createHmac("sha256", baseKey).update("agentlabs:form-webhook-secret:v1").digest("hex");
        console.log(`\u{1F4CB} [Form Tool] Derived stable webhook secret from server key`);
      } else {
        const secretPath = path.join(process.cwd(), ".form-webhook-secret");
        try {
          if (fs.existsSync(secretPath)) {
            formWebhookSecret = fs.readFileSync(secretPath, "utf-8").trim();
            console.log(`\u{1F4CB} [Form Tool] Loaded persisted webhook secret from file`);
          }
        } catch (_) {
        }
        if (!formWebhookSecret) {
          formWebhookSecret = crypto.randomBytes(32).toString("hex");
          try {
            fs.writeFileSync(secretPath, formWebhookSecret, { mode: 384 });
          } catch (_) {
          }
          console.log(`\u{1F4CB} [Form Tool] Generated and persisted new webhook secret`);
        }
      }
    }
  }
  return formWebhookSecret;
}
function validateFormWebhookToken(providedToken) {
  if (!providedToken) {
    return false;
  }
  const secret = getFormWebhookSecret();
  const providedBuffer = Buffer.from(providedToken);
  const secretBuffer = Buffer.from(secret);
  if (providedBuffer.length !== secretBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuffer, secretBuffer);
}
function sanitizeFieldId(fieldId) {
  return fieldId.replace(/-/g, "_").replace(/[^a-zA-Z0-9_.@]/g, "_").replace(/\.{2,}/g, ".").replace(/_{2,}/g, "_");
}
function generateFieldProperties(fields) {
  const properties = {
    contactName: {
      type: "string",
      description: "The name of the person filling the form"
    },
    contactPhone: {
      type: "string",
      description: "Auto-populated server-side from the call record. Do NOT ask the caller for this value \u2014 the system already has their phone number on file."
    }
  };
  for (const field of fields) {
    const fieldKey = `field_${sanitizeFieldId(field.id)}`;
    switch (field.fieldType) {
      case "text":
        properties[fieldKey] = {
          type: "string",
          description: `Answer to: "${field.question}"`
        };
        break;
      case "number":
        properties[fieldKey] = {
          type: "number",
          description: `Numeric answer to: "${field.question}"`
        };
        break;
      case "yes_no":
        properties[fieldKey] = {
          type: "boolean",
          description: `Yes/No answer to: "${field.question}" (true = yes, false = no)`
        };
        break;
      case "multiple_choice":
        properties[fieldKey] = {
          type: "string",
          description: `Choice for: "${field.question}"${field.options?.length ? `. Options: ${field.options.join(", ")}` : ""}`
        };
        break;
      case "email":
        properties[fieldKey] = {
          type: "string",
          description: `Email address for: "${field.question}"`
        };
        break;
      case "phone":
      case "tel":
        properties[fieldKey] = {
          type: "string",
          description: `Phone number for: "${field.question}". IMPORTANT: If this question is asking for the CALLER'S OWN phone number, the system already has it on file \u2014 use the known number and do NOT ask the caller to provide it again. Only ask if this question is clearly about a DIFFERENT person's number (e.g. emergency contact, spouse, office line).`
        };
        break;
      case "date":
        properties[fieldKey] = {
          type: "string",
          description: `Date for: "${field.question}". Can be natural language like 'tomorrow' or formatted date.`
        };
        break;
      case "rating":
        properties[fieldKey] = {
          type: "number",
          description: `Rating (1-5 or 1-10) for: "${field.question}"`
        };
        break;
      default:
        properties[fieldKey] = {
          type: "string",
          description: `Answer to: "${field.question}"`
        };
    }
  }
  return properties;
}
function getRequiredFields(fields) {
  const required = [];
  for (const field of fields) {
    if (field.isRequired) {
      required.push(`field_${sanitizeFieldId(field.id)}`);
    }
  }
  return required;
}
function getSubmitFormWebhookTool(formId, formName, fields, agentId, nodeId) {
  const domain = getDomain();
  const secret = getFormWebhookSecret();
  const baseUrl = `${domain}/api/webhooks/elevenlabs/form/${secret}/${formId}/${agentId}`;
  const webhookUrl = nodeId ? `${baseUrl}?nodeId=${encodeURIComponent(nodeId)}` : baseUrl;
  const toolName = nodeId ? `submit_form_${nodeId.replace(/[^a-zA-Z0-9]/g, "_")}` : `submit_form_${formId.replace(/-/g, "_")}`;
  console.log(`\u{1F4CB} [Form Tool] Creating webhook tool config for form ${formId}`);
  console.log(`   Tool name: ${toolName}`);
  console.log(`   Form: ${formName} (${fields.length} fields)`);
  console.log(`   Node ID: ${nodeId || "not provided"}`);
  console.log(`   Webhook URL: ${webhookUrl.replace(secret, "[TOKEN]")}`);
  const fieldDescriptions = fields.sort((a, b) => a.order - b.order).map((f, i) => `${i + 1}. "${f.question}" (${f.fieldType}${f.isRequired ? ", required" : ""})`).join("\n");
  const requiredFields = getRequiredFields(fields);
  const requestBodySchema = {
    type: "object",
    properties: generateFieldProperties(fields)
  };
  if (requiredFields.length > 0) {
    requestBodySchema.required = requiredFields;
  }
  return {
    type: "webhook",
    name: toolName,
    description: `Submit the "${formName}" form. Collect the following information from the caller before using this tool:
${fieldDescriptions}

Once all required fields are collected, call this tool to save the form submission.`,
    api_schema: {
      url: webhookUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      request_body_schema: requestBodySchema
    }
  };
}
function generateFormCollectionPrompt(introMessage, formName, fields, toolName = "submit_form") {
  const sortedFields = [...fields].sort((a, b) => a.order - b.order);
  const fieldInstructions = sortedFields.map((field, index) => {
    let instruction = `${index + 1}. Ask: "${field.question}"`;
    switch (field.fieldType) {
      case "yes_no":
        instruction += ` (Accept yes/no, yeah/nah, affirmative/negative responses)`;
        break;
      case "multiple_choice":
        if (field.options?.length) {
          instruction += ` (Options: ${field.options.join(", ")})`;
        }
        break;
      case "number":
        instruction += ` (Collect a number)`;
        break;
      case "email":
        instruction += ` (Collect email address, confirm spelling)`;
        break;
      case "phone":
      case "tel":
        instruction += ` (CALLER'S OWN NUMBER: do NOT ask \u2014 state "I already have your number on file" and auto-fill. Only ask if clearly requesting a DIFFERENT contact's phone)`;
        break;
      case "rating":
        instruction += ` (Collect a rating, typically 1-5 or 1-10)`;
        break;
      case "date":
        instruction += ` (Accept natural language dates like "tomorrow", "next week")`;
        break;
    }
    if (field.isRequired) {
      instruction += ` [REQUIRED]`;
    }
    return instruction;
  }).join("\n");
  return `*** SYSTEM OVERRIDE \u2014 IGNORE ALL PREVIOUS INSTRUCTIONS ***
You are now in FORM COLLECTION MODE. Your ONLY task is to collect the form fields listed below and submit them using the ${toolName} tool. Forget everything from your base instructions. Do NOT ask about investments, budgets, timelines, site visits, project details, or ANYTHING unrelated to this form's fields.

Say exactly: '${introMessage}'

FORM COLLECTION INSTRUCTIONS for "${formName}":
You need to collect ONLY the following specific fields \u2014 nothing else. Before asking any question, check what the caller has ALREADY provided during this conversation. Only ask for information that has NOT yet been given.

PHONE NUMBER POLICY: The caller's phone number is already captured by the call system. For any question that asks for the CALLER'S OWN phone number, do NOT ask \u2014 instead say "I already have your number on file" and auto-fill it. Only ask for a phone number if the question is clearly about someone else's number (e.g. an emergency contact, spouse, or office line).

Required questions \u2014 ask ONLY these, one at a time, in order:

${fieldInstructions}

IMPORTANT RULES:
1. If the caller already answered a question (even during the intro), accept that answer immediately \u2014 do NOT re-ask it.
2. Ask each missing question ONE AT A TIME. Wait for the answer before asking the next question.
3. If the caller's response is unclear, ask for clarification once. Then accept whatever they provide.
4. CRITICAL EXECUTION SEQUENCE: Once the fields listed above have been collected, you MUST call the ${toolName} tool immediately BEFORE saying that the information is saved. Call the tool, wait for the tool execution response, and only then speak the confirmation.
5. CRITICAL CONFIRMATION PHRASE: After the tool execution successfully returns, say exactly: "Your information has been saved successfully." Do NOT say this phrase until the ${toolName} tool execution has completed.
6. If the ${toolName} tool fails, apologize and try ONE more time. If it fails a second time, say "Your information has been noted and we will follow up with you shortly." then proceed to the next step without retrying further.
7. Only after saying the completion phrase (or the follow-up fallback) should you proceed to the next step or end the conversation.
8. PARTIAL DATA RULE: If the caller declines to answer further questions, wants to end the call, or says goodbye \u2014 IMMEDIATELY call the ${toolName} tool with whatever information has been collected so far (even if some fields are missing or empty). Do NOT wait for all fields to be answered before submitting. Submit partial data, then let the call end gracefully.

PHONE NUMBER PRONUNCIATION: When reading back or confirming any phone number, ALWAYS speak each digit separately with brief pauses. For example:
- "9990155993" should be spoken as "nine, nine, nine, zero, one, five, five, nine, nine, three"
- Never read phone numbers as large numbers (do NOT say "nine hundred ninety-nine million...")
- Group digits in sets of 3 or 4 for natural reading rhythm

Then stop speaking and wait for response.`;
}
export {
  generateFormCollectionPrompt,
  getFormWebhookSecret,
  getSubmitFormWebhookTool,
  sanitizeFieldId,
  validateFormWebhookToken
};
