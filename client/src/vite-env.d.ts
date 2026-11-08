/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Chatbot staff inbox at /app/chatbot-inbox. Off unless "true". */
  readonly VITE_ENABLE_CHATBOT_INBOX?: string;
  /** Chatbot admin screens under /app/chatbot-admin/. Off unless "true". */
  readonly VITE_ENABLE_CHATBOT_ADMIN?: string;
  /** Builder wizard Train step. Off unless "true". */
  readonly VITE_ENABLE_CHATBOT_BUILDER_TRAIN?: string;
  /** Builder wizard Channel step. Off unless "true". */
  readonly VITE_ENABLE_CHATBOT_BUILDER_CHANNEL?: string;
  /** Builder wizard routes. Off unless "true". */
  readonly VITE_ENABLE_CHATBOT_BUILDER_ROUTES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
