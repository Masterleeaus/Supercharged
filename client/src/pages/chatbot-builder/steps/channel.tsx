/**
 * Channel step for the chatbot builder wizard (core: edit-step-channel.blade.php).
 *
 * Hidden. The step renders nothing while CHANNEL_STEP_ENABLED is false, and steps.ts keeps `enabled: false`.
 * See DECISIONS.md for the two lines the owner changes to turn it on.
 *
 * Every channel is external: Telegram, WhatsApp (Twilio), Messenger and Instagram each call a provider. Nothing
 * here calls a provider from the browser. Connect and test show a pending state until the channel service exists.
 *
 * Credentials are not part of WizardState. The shell keeps WizardState in a localStorage draft, so a secret stored
 * there would be written to disk. Typed values stay in this component's memory only, and a saved secret is never
 * sent back to the browser: the field shows a masked placeholder and sends a value only when the user types one.
 */
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { StepProps } from "../types";

/** Owner switch. Keep false until the channel service exists. See DECISIONS.md. */
export const CHANNEL_STEP_ENABLED = false;

type ChannelKey = "telegram" | "whatsapp" | "messenger" | "instagram";
type ChannelAction = "connect" | "test";

interface FieldDef {
  /** Key inside the channel's credentials object (core: credentials[<key>]). */
  key: string;
  label: string;
  /** Secret fields are masked once saved and are never shown back in full. */
  secret: boolean;
  /** When set, the field is a select with these values. */
  options?: string[];
}

interface ChannelDef {
  key: ChannelKey;
  label: string;
  description: string;
  /** "fields": the user types credentials. "oauth": the channel signs in with Instagram and types nothing. */
  flow: "fields" | "oauth";
  fields: FieldDef[];
}

/** Credential fields, from the core add-on channel cards (chatbot-telegram, -whatsapp, -messenger, -instagram). */
const CHANNELS: ChannelDef[] = [
  {
    key: "telegram",
    label: "Telegram",
    description: "A Telegram bot, connected with its bot token.",
    flow: "fields",
    fields: [
      { key: "telegram_bot_name", label: "Bot name", secret: false },
      { key: "telegram_token", label: "Bot token", secret: true },
    ],
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    description: "WhatsApp through Twilio.",
    flow: "fields",
    fields: [
      { key: "whatsapp_environment", label: "Environment", secret: false, options: ["sandbox", "production"] },
      { key: "whatsapp_sid", label: "Account SID", secret: true },
      { key: "whatsapp_token", label: "Auth token", secret: true },
      { key: "whatsapp_phone", label: "Production phone number", secret: false },
      { key: "whatsapp_sandbox_phone", label: "Sandbox phone number", secret: false },
    ],
  },
  {
    key: "messenger",
    label: "Messenger",
    description: "A Facebook Page, connected through a Meta app.",
    flow: "fields",
    fields: [
      { key: "app_id", label: "App ID", secret: false },
      { key: "app_secret", label: "App secret", secret: true },
      { key: "page_name", label: "Page name", secret: false },
      { key: "verify_token", label: "Webhook verify token", secret: true },
    ],
  },
  {
    key: "instagram",
    label: "Instagram",
    description: "An Instagram account, connected by signing in with Instagram. Nothing to type.",
    flow: "oauth",
    fields: [],
  },
];

/** Per-channel local state. None of it is written to WizardState. */
interface ChannelUi {
  /** Set by the switch. The switch stays disabled until `connected` is true. */
  enabled: boolean;
  /** True once the channel service has connected this channel. Never true until that service exists. */
  connected: boolean;
  /** The action that is waiting on the channel service, or null. */
  pending: ChannelAction | null;
  /** Message shown under the card after an action. */
  notice: string | null;
  /** Values typed this session. Only non-empty values are ever sent. */
  typed: Record<string, string>;
  /** Fields the server reports as saved. Their values are never returned, so they are shown masked. */
  secretSaved: Record<string, boolean>;
  /** Saved secret fields the user chose to replace. */
  replacing: Record<string, boolean>;
}

const NOTICE: Record<ChannelAction, string> = {
  connect: "Connecting needs the channel service, which is not built yet. Nothing was sent to the provider.",
  test: "Testing needs the channel service, which is not built yet. No test message was sent.",
};

function freshUi(): ChannelUi {
  return { enabled: false, connected: false, pending: null, notice: null, typed: {}, secretSaved: {}, replacing: {} };
}

function freshUiMap(): Record<ChannelKey, ChannelUi> {
  return { telegram: freshUi(), whatsapp: freshUi(), messenger: freshUi(), instagram: freshUi() };
}

/**
 * Only the typed, non-empty values for this channel's fields. A saved secret that the user did not retype is left out,
 * so the server keeps the value it has.
 */
function pickTypedCredentials(channel: ChannelDef, typed: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of channel.fields) {
    const value = (typed[field.key] ?? "").trim();
    if (value !== "") out[field.key] = value;
  }
  return out;
}

interface ChannelRequest {
  chatbotId: string;
  channel: ChannelKey;
  action: ChannelAction;
  credentials: Record<string, string>;
}

interface ChannelResult {
  state: "pending" | "done";
}

/**
 * Stand-in for the channel service. The service does not exist yet, so this makes no network request and never calls
 * a provider. It always reports "pending". Replace the body with the channel routes once they are in endpoint-map.md.
 */
function requestChannelAction(_request: ChannelRequest): Promise<ChannelResult> {
  return Promise.resolve({ state: "pending" });
}

interface ChannelCardProps {
  def: ChannelDef;
  ui: ChannelUi;
  chatbotId: string | null;
  disabled: boolean;
  onType: (key: string, value: string) => void;
  onReplace: (key: string) => void;
  onAction: (action: ChannelAction) => void;
  onToggle: (enabled: boolean) => void;
}

function FieldInput({
  def,
  field,
  ui,
  disabled,
  onType,
  onReplace,
}: {
  def: ChannelDef;
  field: FieldDef;
  ui: ChannelUi;
  disabled: boolean;
  onType: (key: string, value: string) => void;
  onReplace: (key: string) => void;
}) {
  const id = `channel-${def.key}-${field.key}`;
  const saved = field.secret && ui.secretSaved[field.key] === true;

  if (saved && !ui.replacing[field.key]) {
    // The stored value is never fetched, so the input is empty and only the mask is shown.
    return (
      <div className="flex items-center gap-2">
        <Input id={id} value="" placeholder="••••••••••••" readOnly disabled aria-describedby={`${id}-saved`} />
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onReplace(field.key)}>
          Replace
        </Button>
        <span id={`${id}-saved`} className="sr-only">
          A value is saved. It is hidden.
        </span>
      </div>
    );
  }

  if (field.options) {
    return (
      <select
        id={id}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        value={ui.typed[field.key] ?? ""}
        disabled={disabled}
        onChange={(e) => onType(field.key, e.target.value)}
      >
        <option value="">Not set</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  return (
    <Input
      id={id}
      type={field.secret ? "password" : "text"}
      autoComplete={field.secret ? "new-password" : "off"}
      value={ui.typed[field.key] ?? ""}
      placeholder={saved ? "Enter a new value to replace" : undefined}
      disabled={disabled}
      onChange={(e) => onType(field.key, e.target.value)}
    />
  );
}

function buttonLabel(pending: boolean, idle: string): string {
  return pending ? `${idle} (pending)` : idle;
}

function ChannelCard({ def, ui, chatbotId, disabled, onType, onReplace, onAction, onToggle }: ChannelCardProps) {
  const off = disabled || chatbotId === null;
  const isPending = ui.pending !== null;

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">{def.label}</h3>
          <p className="text-xs text-muted-foreground">{def.description}</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline">{ui.connected ? "Connected" : "Not connected"}</Badge>
          <Switch
            checked={ui.enabled}
            disabled={off || !ui.connected}
            onCheckedChange={onToggle}
            aria-label={`Enable ${def.label}`}
          />
        </div>
      </div>

      {def.fields.map((field) => (
        <div key={field.key} className="flex flex-col gap-1.5">
          <Label htmlFor={`channel-${def.key}-${field.key}`}>{field.label}</Label>
          <FieldInput def={def} field={field} ui={ui} disabled={off || isPending} onType={onType} onReplace={onReplace} />
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={off || isPending} onClick={() => onAction("connect")}>
          {buttonLabel(ui.pending === "connect", def.flow === "oauth" ? "Sign in with Instagram" : "Connect")}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={off || isPending} onClick={() => onAction("test")}>
          {buttonLabel(ui.pending === "test", "Send test message")}
        </Button>
        {isPending && <Badge variant="secondary">Pending</Badge>}
      </div>

      {ui.notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {ui.notice}
        </p>
      )}
    </Card>
  );
}

export default function ChannelStep(props: StepProps<"channel">) {
  const { chatbotId, disabled } = props;
  const [ui, setUi] = useState<Record<ChannelKey, ChannelUi>>(freshUiMap);

  // Hooks above, so the early return below does not change the hook order.
  if (!CHANNEL_STEP_ENABLED) return null;

  // Functional updates, so a fast sequence of keystrokes never reads a stale typed map.
  const patch = (key: ChannelKey, change: (prev: ChannelUi) => Partial<ChannelUi>) =>
    setUi((prev) => ({ ...prev, [key]: { ...prev[key], ...change(prev[key]) } }));

  const runAction = async (def: ChannelDef, action: ChannelAction) => {
    if (chatbotId === null) return;
    patch(def.key, () => ({ pending: action, notice: null }));
    const typed = ui[def.key].typed;
    const credentials = def.flow === "fields" && action === "connect" ? pickTypedCredentials(def, typed) : {};
    const result = await requestChannelAction({ chatbotId, channel: def.key, action, credentials });
    patch(def.key, () => ({
      pending: result.state === "pending" ? action : null,
      notice: NOTICE[action],
    }));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Channels</h2>
        <p className="text-sm text-muted-foreground">
          Connect this chatbot to messaging channels. Each channel is run by an outside service.
        </p>
      </div>

      {chatbotId === null && (
        <Alert>
          <AlertDescription>Save the chatbot first. Channels attach to a saved chatbot.</AlertDescription>
        </Alert>
      )}

      <Alert>
        <AlertDescription>
          Channel connections are pending. The channel service is not built yet, so nothing on this step connects to a
          provider.
        </AlertDescription>
      </Alert>

      <Card className="p-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">Website</h3>
          <p className="text-xs text-muted-foreground">
            The chat widget on your site. It has no channel record here. Set it up in Test and embed.
          </p>
        </div>
      </Card>

      {CHANNELS.map((def) => (
        <ChannelCard
          key={def.key}
          def={def}
          ui={ui[def.key]}
          chatbotId={chatbotId}
          disabled={disabled}
          onType={(key, value) => patch(def.key, (prev) => ({ typed: { ...prev.typed, [key]: value } }))}
          onReplace={(key) => patch(def.key, (prev) => ({ replacing: { ...prev.replacing, [key]: true } }))}
          onAction={(action) => void runAction(def, action)}
          onToggle={(enabled) => patch(def.key, () => ({ enabled }))}
        />
      ))}
    </div>
  );
}
