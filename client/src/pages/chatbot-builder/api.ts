/**
 * Typed calls for the chatbot builder wizard.
 *
 * EXISTS endpoints are in server/modules/chatbot/chatbot-routes.ts today.
 * NEW endpoints are marked "backend pending: builder-routes". Their request and response shapes are the
 * contract in server/modules/chatbot/builder-routes/endpoint-map.md.
 * EXTERNAL work (training, channels) has no functions here. See DECISIONS.md.
 */
import { ApiError, apiRequest } from "@/lib/queryClient";
import { AuthStorage } from "@/lib/auth-storage";
import type { ConfigureState, CustomizeState, EmbedState, UploadKind, WizardState } from "./types";

const CHATBOT_BASE = "/api/chatbot";
const BUILDER_BASE = "/api/chatbot/builder";

export const CHATBOTS_QUERY_KEY = ["chatbot", "chatbots"] as const;
export const builderQueryKey = (id: string) => ["chatbot", "builder", id] as const;

// ---------------------------------------------------------------------------
// EXISTS: chatbot list and create
// ---------------------------------------------------------------------------

/** Wire shape of GET and POST /api/chatbot/chatbots. Same as the existing ChatbotBuilder page. */
export interface ChatbotRecord {
  id: string;
  title: string;
  language: string;
  welcomeMessage: string | null;
  instructions: string | null;
  generativeUiEnabled: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Body of POST /api/chatbot/chatbots. The route is strict: send only these keys. */
export interface CreateChatbotBody {
  title: string;
  language?: string;
  welcomeMessage?: string | null;
  instructions?: string | null;
  generativeUiEnabled?: boolean;
  active?: boolean;
}

/** EXISTS. GET /api/chatbot/chatbots */
export async function listChatbots(): Promise<ChatbotRecord[]> {
  const res = await apiRequest("GET", `${CHATBOT_BASE}/chatbots`);
  return (await res.json()) as ChatbotRecord[];
}

/** EXISTS. POST /api/chatbot/chatbots. Used only to create a chatbot on the first save of the wizard. */
export async function createChatbot(body: CreateChatbotBody): Promise<ChatbotRecord> {
  const res = await apiRequest("POST", `${CHATBOT_BASE}/chatbots`, body);
  return (await res.json()) as ChatbotRecord;
}

// ---------------------------------------------------------------------------
// NEW: builder state (one read, one partial write)
// ---------------------------------------------------------------------------

/** Response of GET and PATCH /api/chatbot/builder/:id. */
export interface BuilderSnapshot {
  id: string;
  state: WizardState;
  updatedAt: string;
}

/**
 * Body of PATCH /api/chatbot/builder/:id. Send only the groups that changed, and only the keys that changed
 * inside them. The backend merges them. `embed.uuid` is read-only and is left out of the type.
 */
export interface BuilderPatch {
  configure?: Partial<ConfigureState>;
  customize?: Partial<CustomizeState>;
  embed?: Partial<Omit<EmbedState, "uuid">>;
}

/** NEW. backend pending: builder-routes. GET /api/chatbot/builder/:id */
export async function getBuilder(chatbotId: string): Promise<BuilderSnapshot> {
  const res = await apiRequest("GET", `${BUILDER_BASE}/${encodeURIComponent(chatbotId)}`);
  return (await res.json()) as BuilderSnapshot;
}

/** NEW. backend pending: builder-routes. PATCH /api/chatbot/builder/:id */
export async function patchBuilder(chatbotId: string, patch: BuilderPatch): Promise<BuilderSnapshot> {
  const res = await apiRequest("PATCH", `${BUILDER_BASE}/${encodeURIComponent(chatbotId)}`, patch);
  return (await res.json()) as BuilderSnapshot;
}

// ---------------------------------------------------------------------------
// NEW: uploads and avatars (multipart)
// ---------------------------------------------------------------------------

export interface UploadedImage {
  /** Value to store in the matching field (for example customize.logo). */
  path: string;
  /** URL for the preview. */
  url: string;
}

export interface BuilderAvatar {
  id: string;
  /** Value to store in customize.avatar. */
  path: string;
  url: string;
}

/**
 * Multipart POST. apiRequest only sends JSON, so this sends FormData itself with the same Authorization
 * header. It does not refresh an expired token (see DECISIONS.md).
 */
async function postForm<T>(url: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const auth = AuthStorage.getAuthHeader();
  if (auth) headers.Authorization = auth;

  const res = await fetch(url, { method: "POST", headers, body: form, credentials: "include" });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `Upload failed (${res.status})`;
    throw new ApiError(message, res.status, data);
  }
  return data as T;
}

/**
 * NEW. backend pending: builder-routes. POST /api/chatbot/builder/:id/uploads
 * Multipart fields: kind (UploadKind), file (image, max 4 MB). Requires a saved chatbot.
 */
export async function uploadBuilderImage(chatbotId: string, kind: UploadKind, file: File): Promise<UploadedImage> {
  const form = new FormData();
  form.append("kind", kind);
  form.append("file", file);
  return postForm<UploadedImage>(`${BUILDER_BASE}/${encodeURIComponent(chatbotId)}/uploads`, form);
}

/** NEW. backend pending: builder-routes. GET /api/chatbot/builder/avatars (presets plus this company's uploads). */
export async function listBuilderAvatars(): Promise<BuilderAvatar[]> {
  const res = await apiRequest("GET", `${BUILDER_BASE}/avatars`);
  return (await res.json()) as BuilderAvatar[];
}

/** NEW. backend pending: builder-routes. POST /api/chatbot/builder/avatars. Multipart field: avatar (image, max 4 MB). */
export async function uploadBuilderAvatar(file: File): Promise<BuilderAvatar> {
  const form = new FormData();
  form.append("avatar", file);
  return postForm<BuilderAvatar>(`${BUILDER_BASE}/avatars`, form);
}
