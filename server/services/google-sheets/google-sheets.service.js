import { db } from "../../db.js";
import { googleSheetsCredentials } from "../../../shared/schema.js";
import { eq } from "drizzle-orm";
import { storage } from "../../storage.js";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3/files";
async function getGoogleCredentials() {
  try {
    const [dbClientId, dbClientSecret] = await Promise.all([
      storage.getGlobalSetting("google_client_id"),
      storage.getGlobalSetting("google_client_secret")
    ]);
    const clientId = dbClientId?.value?.trim() || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = dbClientSecret?.value?.trim() || process.env.GOOGLE_CLIENT_SECRET;
    if (clientId && clientSecret) return { clientId, clientSecret };
  } catch (err) {
    console.error("[GoogleSheets] Failed to read credentials from DB, falling back to env:", err.message);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (clientId && clientSecret) return { clientId, clientSecret };
  }
  return null;
}
async function refreshAccessToken(userId, force = false) {
  const [cred] = await db.select().from(googleSheetsCredentials).where(eq(googleSheetsCredentials.userId, userId)).limit(1);
  if (!cred) return null;
  const now = /* @__PURE__ */ new Date();
  if (!force && cred.tokenExpiry > now) {
    return cred.accessToken;
  }
  const creds = await getGoogleCredentials();
  if (!creds) {
    console.error("[GoogleSheets] Google OAuth credentials not configured (DB or env)");
    return null;
  }
  const { clientId, clientSecret } = creds;
  try {
    const resp = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: cred.refreshToken,
        grant_type: "refresh_token"
      })
    });
    if (!resp.ok) {
      console.error("[GoogleSheets] Token refresh failed:", await resp.text());
      return null;
    }
    const data = await resp.json();
    const newExpiry = new Date(Date.now() + data.expires_in * 1e3);
    await db.update(googleSheetsCredentials).set({
      accessToken: data.access_token,
      tokenExpiry: newExpiry,
      updatedAt: /* @__PURE__ */ new Date()
    }).where(eq(googleSheetsCredentials.userId, userId));
    return data.access_token;
  } catch (err) {
    console.error("[GoogleSheets] Token refresh error:", err.message);
    return null;
  }
}
async function listUserSheets(userId) {
  let token = await refreshAccessToken(userId);
  if (!token) return [];
  const doFetch = (t) => {
    const url = new URL(GOOGLE_DRIVE_API);
    url.searchParams.set("q", "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
    url.searchParams.set("fields", "files(id,name)");
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("pageSize", "100");
    return fetch(url.toString(), { headers: { Authorization: `Bearer ${t}` } });
  };
  try {
    let resp = await doFetch(token);
    if (resp.status === 401) {
      console.warn("[GoogleSheets] Got 401 on listUserSheets, forcing token refresh...");
      const fresh = await refreshAccessToken(userId, true);
      if (!fresh) return [];
      resp = await doFetch(fresh);
    }
    if (!resp.ok) {
      console.error("[GoogleSheets] List sheets failed:", await resp.text());
      return [];
    }
    const data = await resp.json();
    return (data.files || []).map((f) => ({ id: f.id, name: f.name }));
  } catch (err) {
    console.error("[GoogleSheets] List sheets error:", err.message);
    return [];
  }
}
async function listSheetTabs(userId, spreadsheetId) {
  let token = await refreshAccessToken(userId);
  if (!token) return [];
  const doFetch = (t) => {
    const url = `${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(title,sheetId)`;
    return fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  };
  try {
    let resp = await doFetch(token);
    if (resp.status === 401) {
      console.warn("[GoogleSheets] Got 401 on listSheetTabs, forcing token refresh...");
      const fresh = await refreshAccessToken(userId, true);
      if (!fresh) return [];
      resp = await doFetch(fresh);
    }
    if (!resp.ok) {
      console.error("[GoogleSheets] List tabs failed:", await resp.text());
      return [];
    }
    const data = await resp.json();
    return (data.sheets || []).map((s) => ({
      title: s.properties.title,
      sheetId: s.properties.sheetId
    }));
  } catch (err) {
    console.error("[GoogleSheets] List tabs error:", err.message);
    return [];
  }
}
async function readSheetRow1(accessToken, spreadsheetId, sheetName) {
  const range = encodeURIComponent(`${sheetName}!A1:Z1`);
  const url = `${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${range}`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (resp.status === 401) return null;
    if (!resp.ok) {
      console.warn(`[GoogleSheets] readSheetRow1 failed (${resp.status}) for sheet ${spreadsheetId}`);
      return null;
    }
    const data = await resp.json();
    return data.values?.[0] ?? [];
  } catch (err) {
    console.warn("[GoogleSheets] readSheetRow1 error:", err.message);
    return null;
  }
}
async function ensureSheetHeaders(userId, spreadsheetId, sheetName, headerRow) {
  let token = await refreshAccessToken(userId);
  if (!token) {
    console.warn("[GoogleSheets] ensureSheetHeaders: no valid token for user:", userId);
    return false;
  }
  try {
    let existing = await readSheetRow1(token, spreadsheetId, sheetName);
    if (existing === null) {
      console.warn(`[GoogleSheets] readSheetRow1 returned null for sheet ${spreadsheetId} tab "${sheetName}" \u2014 forcing token refresh`);
      const freshToken = await refreshAccessToken(userId, true);
      if (!freshToken) return false;
      token = freshToken;
      existing = await readSheetRow1(freshToken, spreadsheetId, sheetName);
      if (existing === null) {
        console.error(`[GoogleSheets] readSheetRow1 still failed after token refresh for sheet ${spreadsheetId}`);
        return false;
      }
    }
    if (existing.length > 0) {
      console.log(`[GoogleSheets] Header row already exists in "${sheetName}" \u2014 skipping write`);
      return false;
    }
    const range = encodeURIComponent(`${sheetName}!A1`);
    const url = `${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${range}?valueInputOption=USER_ENTERED`;
    let resp = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [headerRow], range: `${sheetName}!A1` })
    });
    if (resp.status === 401) {
      const freshToken = await refreshAccessToken(userId, true);
      if (!freshToken) return false;
      resp = await fetch(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${freshToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [headerRow], range: `${sheetName}!A1` })
      });
    }
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[GoogleSheets] ensureSheetHeaders write failed for sheet ${spreadsheetId} tab "${sheetName}":`, errText);
      return false;
    }
    console.log(`[GoogleSheets] Header row written to "${sheetName}" (${spreadsheetId}): [${headerRow.join(", ")}]`);
    return true;
  } catch (err) {
    console.error("[GoogleSheets] ensureSheetHeaders error:", err.message);
    return false;
  }
}
async function appendRowToSheet(userId, spreadsheetId, sheetName, rowData) {
  const token = await refreshAccessToken(userId);
  if (!token) {
    console.error("[GoogleSheets] No valid token for user:", userId);
    return false;
  }
  const doAppend = async (accessToken) => {
    const range = encodeURIComponent(`${sheetName}!A1`);
    const url = `${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    return fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [rowData] })
    });
  };
  try {
    let resp = await doAppend(token);
    if (resp.status === 401) {
      console.warn("[GoogleSheets] Got 401, forcing token refresh and retrying append...");
      const freshToken = await refreshAccessToken(userId, true);
      if (!freshToken) {
        console.error("[GoogleSheets] Force refresh failed \u2014 cannot append row");
        return false;
      }
      resp = await doAppend(freshToken);
    }
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[GoogleSheets] Append row failed:", errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[GoogleSheets] Append row error:", err.message);
    return false;
  }
}
async function getConnectionStatus(userId) {
  const [cred] = await db.select({ connectedEmail: googleSheetsCredentials.connectedEmail }).from(googleSheetsCredentials).where(eq(googleSheetsCredentials.userId, userId)).limit(1);
  if (!cred) return { connected: false };
  return { connected: true, email: cred.connectedEmail };
}
async function disconnectGoogleSheets(userId) {
  await db.delete(googleSheetsCredentials).where(eq(googleSheetsCredentials.userId, userId));
}
export {
  appendRowToSheet,
  disconnectGoogleSheets,
  ensureSheetHeaders,
  getConnectionStatus,
  getGoogleCredentials,
  listSheetTabs,
  listUserSheets
};
