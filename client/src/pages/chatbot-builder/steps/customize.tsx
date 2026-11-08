/**
 * Customize step of the chatbot builder wizard. Ports core edit-step-customize.blade.php.
 *
 * Every field here is NEW (see server/modules/chatbot/builder-routes/endpoint-map.md, section 2, Step 2).
 * Image uploads call uploadBuilderImage and the avatar upload calls uploadBuilderAvatar. Both are
 * backend pending (builder-routes), so the step shows a pending or failed state instead of hiding them.
 * Promo banner and suggested prompts are configure fields in the contract, so they are not in this step.
 *
 * The live preview is a schematic React render of the bubble and window. It does not load the core
 * embed bundle, and it uses placeholder text for the title and welcome message, which live in configure.
 */
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageCircle, Plus, Save, Smile, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { listBuilderAvatars, uploadBuilderAvatar, uploadBuilderImage, type BuilderAvatar } from "../api";
import { BUILDER_LIMITS, type ChatbotPosition, type CustomizeState, type HeaderBgType, type StepProps } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Core predefined accent colours (predefined_colors in the Blade). */
const PRESET_COLORS = ["#272733", "#67D97C", "#E7AC47", "#9D74C9", "#017BE5"] as const;
/** Default accent used by the core widget stylesheet (--lqd-ext-chat-primary). */
const DEFAULT_ACCENT = "#017BE5";
/** Core's default stops, from the commented-out defaults in edit-window.blade.php. */
const DEFAULT_GRADIENT: GradientState = {
  type: "linear-gradient",
  angle: 90,
  stops: [
    { color: "#3B82F6", position: 0 },
    { color: "#8B5CF6", position: 100 },
  ],
};
/** Desk limit. Core has no stop limit. See DECISIONS.md. */
const MAX_GRADIENT_STOPS = 8;
const TRIGGER_MIN = 20;
const TRIGGER_MAX = 100;
const TRIGGER_DEFAULT = 60;
/** Link limit from endpoint-map.md section 4. */
const LINK_MAX = 2048;
const AVATARS_QUERY_KEY = ["chatbot", "builder", "avatars"] as const;

const POSITIONS: Array<{ id: ChatbotPosition; label: string }> = [
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
];

const HEADER_OPTIONS: Array<{ id: HeaderBgType; label: string }> = [
  { id: "color", label: "Solid colour" },
  { id: "gradient", label: "Gradient" },
  { id: "image", label: "Image" },
];

/** Boolean fields of CustomizeState, for typed toggles. */
type BooleanKey = {
  [K in keyof CustomizeState]: CustomizeState[K] extends boolean ? K : never;
}[keyof CustomizeState];

/** Link fields of CustomizeState. */
type LinkKey =
  | "footerLink"
  | "whatsappLink"
  | "telegramLink"
  | "facebookLink"
  | "instagramLink"
  | "watchProductTourLink"
  | "privacyPolicyLink"
  | "termsOfServiceLink";

/** Toggles in the same order as the Blade. Hints are the core tooltip text. */
const TOGGLES: Array<{ key: BooleanKey; label: string; hint?: string }> = [
  { key: "isEmailCollect", label: "Email collect", hint: "Request the user email address after they send a message." },
  { key: "isContact", label: "Contact us", hint: "Show the contact link in the welcome screen." },
  { key: "isEmoji", label: "Enable emoji" },
  {
    key: "isLinks",
    label: "Links in welcome screen",
    hint: "Show links in the welcome screen. Configure the links below.",
  },
  {
    key: "showSocialLinksInFirstMessage",
    label: "Links in first assistant message",
    hint: "Show links in the first assistant message. Configure the links below.",
  },
  {
    key: "isGdpr",
    label: "Show GDPR",
    hint: "Show a GDPR notice. Configure the privacy policy and terms links below.",
  },
  { key: "isArticles", label: "Help center" },
  { key: "showLogo", label: "Show logo", hint: "Show the logo in the welcome screen header." },
  { key: "showDateAndTime", label: "Show date and time", hint: "Show the date and time in the conversation messages." },
];

const LINK_ROWS: Array<{ key: LinkKey; label: string; placeholder: string }> = [
  { key: "footerLink", label: "Footer link", placeholder: "https://example.com" },
  { key: "whatsappLink", label: "WhatsApp link", placeholder: "https://wa.me/your-number" },
  { key: "telegramLink", label: "Telegram link", placeholder: "https://t.me/your-profile" },
  { key: "facebookLink", label: "Facebook link", placeholder: "https://facebook.com/your-profile" },
  { key: "instagramLink", label: "Instagram link", placeholder: "https://instagram.com/your-profile" },
  {
    key: "watchProductTourLink",
    label: "Watch product tour",
    placeholder: "https://youtube.com/watch?v=galNNnEcK7I",
  },
];

const GDPR_LINK_ROWS: Array<{ key: LinkKey; label: string; placeholder: string }> = [
  { key: "privacyPolicyLink", label: "Privacy policy link", placeholder: "https://example.com/privacy-policy" },
  {
    key: "termsOfServiceLink",
    label: "Terms of service link",
    placeholder: "https://example.com/terms-of-service",
  },
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

type ParseResult = { ok: true; value: string | null } | { ok: false; error: string };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Returns the hex value in upper case, or null when the text is not #RRGGBB. */
function normalizeHex(raw: string): string | null {
  const text = raw.trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : null;
}

function colourParser(allowEmpty: boolean) {
  return (raw: string): ParseResult => {
    if (allowEmpty && raw.trim() === "") return { ok: true, value: null };
    const hex = normalizeHex(raw);
    if (hex) return { ok: true, value: hex };
    return {
      ok: false,
      error: allowEmpty
        ? "Use six hex digits such as #017BE5, or leave it empty."
        : "Use six hex digits such as #017BE5.",
    };
  };
}

function parseLink(raw: string): ParseResult {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  if (text.length > LINK_MAX) return { ok: false, error: `Use ${LINK_MAX} characters or fewer.` };
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") return { ok: true, value: text };
  } catch {
    // Not a URL. Falls through to the message below.
  }
  return { ok: false, error: "Use a full link that starts with https:// or http://." };
}

/** Client-side image check. The server repeats it (core rule: image, max 4096 KB). */
function validateImageFile(file: File): string | null {
  if (!file.type.startsWith("image/")) return "Choose an image file.";
  if (file.size > BUILDER_LIMITS.uploadBytes) return "Image must be 4 MB or smaller.";
  return null;
}

/** Paths from the server start with "/". Anything else is relative to the site root. */
function imageSrc(path: string): string {
  return /^(https?:|blob:|data:|\/)/.test(path) ? path : `/${path}`;
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Request failed.";
}

function triggerSizePx(raw: string): number {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? clamp(n, TRIGGER_MIN, TRIGGER_MAX) : TRIGGER_DEFAULT;
}

function positionFromX(clientX: number, el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  return clamp(Math.round(((clientX - rect.left) / (rect.width || 1)) * 100), 0, 100);
}

// ---------------------------------------------------------------------------
// Gradient model. Same output format as core's gradientPicker (edit-window.blade.php).
// ---------------------------------------------------------------------------

type GradientType = "linear-gradient" | "radial-gradient";

interface GradientStop {
  color: string;
  position: number;
}

interface GradientState {
  type: GradientType;
  angle: number;
  stops: GradientStop[];
}

function buildGradient(g: GradientState): string {
  const stops = [...g.stops]
    .sort((a, b) => a.position - b.position)
    .map((s) => `${s.color} ${s.position}%`)
    .join(", ");
  return g.type === "linear-gradient" ? `linear-gradient(${g.angle}deg, ${stops})` : `radial-gradient(circle, ${stops})`;
}

/** Reads the core format back. Returns null for anything else, so the editor shows its default. */
function parseGradient(css: string): GradientState | null {
  const text = css.trim();
  const linear = /^linear-gradient\((\d{1,3})deg,\s*(.+)\)$/.exec(text);
  const radial = /^radial-gradient\(circle,\s*(.+)\)$/.exec(text);
  const body = linear ? linear[2] : radial ? radial[1] : null;
  if (body === null) return null;

  const type: GradientType = linear ? "linear-gradient" : "radial-gradient";
  const angle = linear ? Number(linear[1]) : 90;
  if (angle > 360) return null;

  const stops: GradientStop[] = [];
  for (const part of body.split(",")) {
    const match = /^\s*(#[0-9a-f]{6})\s+(\d{1,3})%\s*$/i.exec(part);
    if (!match || Number(match[2]) > 100) return null;
    stops.push({ color: match[1].toUpperCase(), position: Number(match[2]) });
  }
  if (stops.length < 2 || stops.length > MAX_GRADIENT_STOPS) return null;
  return { type, angle, stops };
}

function mixHex(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** Colour at a position, blended from the neighbouring stops (core interpolateColor). */
function colourAt(stops: GradientStop[], position: number): string {
  const sorted = [...stops].sort((x, y) => x.position - y.position);
  const left = [...sorted].reverse().find((s) => s.position <= position);
  const right = sorted.find((s) => s.position >= position);
  if (!left) return right?.color ?? DEFAULT_ACCENT;
  if (!right || right.position === left.position) return left.color;
  return mixHex(left.color, right.color, (position - left.position) / (right.position - left.position));
}

/** Position for the "Add a colour stop" button (core addGradientStopAtEnd, simplified). */
function nextStopPosition(stops: GradientStop[]): number {
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const max = sorted[sorted.length - 1]?.position ?? 0;
  if (max < 100) return Math.min(100, max + 10);
  let largest = 5;
  let at = 50;
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1].position - sorted[i].position;
    if (gap > largest) {
      largest = gap;
      at = sorted[i].position + gap / 2;
    }
  }
  return Math.round(at);
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

interface ToggleRowProps {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}

function ToggleRow({ id, label, hint, checked, disabled, onCheckedChange }: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-xs font-medium">
          {label}
        </Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}

interface CommitTextFieldProps {
  id: string;
  label: string;
  value: string | null;
  disabled: boolean;
  placeholder?: string;
  mono?: boolean;
  parse: (text: string) => ParseResult;
  onCommit: (value: string | null) => void;
  /** When set, shows a native colour picker. The fallback is shown when the saved value is null. */
  colourPicker?: { fallback: string };
}

/**
 * A text input that only commits valid values. Invalid text stays in the box with an error, and the saved
 * value is not changed. When the saved value changes from outside (draft restored or discarded), the text
 * is replaced.
 */
function CommitTextField({ id, label, value, disabled, placeholder, mono, parse, onCommit, colourPicker }: CommitTextFieldProps) {
  const [text, setText] = useState(value ?? "");
  const [error, setError] = useState<string | null>(null);
  const lastValue = useRef(value);
  const errorId = `${id}-error`;

  useEffect(() => {
    if (lastValue.current === value) return;
    lastValue.current = value;
    setText(value ?? "");
    setError(null);
  }, [value]);

  function commit(next: string | null) {
    lastValue.current = next;
    onCommit(next);
  }

  function handleText(raw: string) {
    setText(raw);
    const result = parse(raw);
    if (result.ok) {
      setError(null);
      commit(result.value);
    } else {
      setError(result.error);
    }
  }

  function handleBlur() {
    if (error) {
      setError(null);
      setText(value ?? "");
    }
  }

  function handlePicker(raw: string) {
    const hex = normalizeHex(raw);
    if (!hex) return;
    setText(hex);
    setError(null);
    commit(hex);
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        {colourPicker && (
          <input
            type="color"
            aria-label={`${label}, colour picker`}
            value={(value ?? colourPicker.fallback).toLowerCase()}
            disabled={disabled}
            onChange={(e) => handlePicker(e.target.value)}
            className="size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5 disabled:cursor-not-allowed"
          />
        )}
        <Input
          id={id}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => handleText(e.target.value)}
          onBlur={handleBlur}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          spellCheck={false}
          className={cn(mono && "font-mono")}
        />
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

interface ImageUploadFieldProps {
  id: string;
  label: string;
  kind: "logo" | "welcome_bg" | "header_bg";
  value: string | null;
  chatbotId: string | null;
  disabled: boolean;
  onUploaded: (path: string) => void;
}

/**
 * File picker, local preview and an explicit upload button. The upload call is backend pending
 * (builder-routes). Until that route exists, the call fails and the field shows the error. The saved
 * value is only changed after the server returns a path.
 */
function ImageUploadField({ id, label, kind, value, chatbotId, disabled, onUploaded }: ImageUploadFieldProps) {
  const [picked, setPicked] = useState<{ file: File; url: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const blocked = disabled || chatbotId === null;

  const upload = useMutation({
    // backend pending: builder-routes. POST /api/chatbot/builder/:id/uploads
    mutationFn: (file: File) => {
      if (chatbotId === null) throw new Error("Save the chatbot first.");
      return uploadBuilderImage(chatbotId, kind, file);
    },
    onSuccess: (image) => {
      onUploaded(image.path);
      setPicked(null);
    },
  });

  // Free the object URL when the picked file changes or the step unmounts.
  useEffect(() => {
    return () => {
      if (picked) URL.revokeObjectURL(picked.url);
    };
  }, [picked]);

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const problem = validateImageFile(file);
    setFileError(problem);
    upload.reset();
    if (problem) return;
    setPicked({ file, url: URL.createObjectURL(file) });
  }

  const shown = picked?.url ?? (value ? imageSrc(value) : null);

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-xs font-medium">
        {label}
      </Label>
      <Input
        id={id}
        type="file"
        accept="image/*"
        disabled={blocked || upload.isPending}
        onChange={handleFile}
        aria-describedby={`${id}-status`}
      />
      {chatbotId === null && <p className="text-xs text-muted-foreground">Save the chatbot first to upload images.</p>}
      {shown && (
        <img
          src={shown}
          alt={`${label} preview`}
          className={cn("h-20 w-full rounded-md border object-cover", upload.isPending && "opacity-60")}
        />
      )}
      <div id={`${id}-status`} className="flex flex-wrap items-center gap-2">
        {picked && (
          <>
            <Button type="button" size="sm" disabled={blocked || upload.isPending} onClick={() => upload.mutate(picked.file)}>
              {upload.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {upload.isPending ? "Uploading..." : "Upload"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {upload.isPending ? "Upload pending (backend: builder routes)." : "Not uploaded yet."}
            </span>
          </>
        )}
        {!picked && value && <span className="text-xs text-muted-foreground">Image set. It is saved with the next save.</span>}
      </div>
      {fileError && (
        <p role="alert" className="text-xs text-destructive">
          {fileError}
        </p>
      )}
      {upload.isError && (
        <p role="alert" className="text-xs text-destructive">
          Upload failed: {errorText(upload.error)}. The upload endpoint is backend pending.
        </p>
      )}
    </div>
  );
}

interface AvatarPickerProps {
  value: string | null;
  avatars: BuilderAvatar[];
  loading: boolean;
  loadError: unknown;
  disabled: boolean;
  onPick: (path: string) => void;
}

function AvatarPicker({ value, avatars, loading, loadError, disabled, onPick }: AvatarPickerProps) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const upload = useMutation({
    // backend pending: builder-routes. POST /api/chatbot/builder/avatars
    mutationFn: (file: File) => uploadBuilderAvatar(file),
    onSuccess: (avatar) => {
      onPick(avatar.path);
      void queryClient.invalidateQueries({ queryKey: AVATARS_QUERY_KEY });
    },
  });

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const problem = validateImageFile(file);
    setFileError(problem);
    upload.reset();
    if (!problem) upload.mutate(file);
  }

  return (
    <div className="space-y-3">
      {loading && <p className="text-xs text-muted-foreground">Loading avatars...</p>}
      {loadError !== null && loadError !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          Avatar presets are not available yet ({errorText(loadError)}). Backend pending: builder routes.
        </p>
      )}
      <div role="radiogroup" aria-label="Avatar" className="grid grid-cols-4 gap-3 sm:grid-cols-6">
        {avatars.map((avatar) => {
          const selected = value === avatar.path;
          return (
            <button
              key={avatar.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`Avatar ${avatar.id}`}
              disabled={disabled}
              onClick={() => onPick(avatar.path)}
              className={cn(
                "size-10 justify-self-center rounded-full transition hover:scale-110 disabled:opacity-50",
                selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
              )}
            >
              <img src={avatar.url} alt="" width={40} height={40} className="size-full rounded-full object-cover" />
            </button>
          );
        })}
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Upload avatar"
          disabled={disabled || upload.isPending}
          onClick={() => fileRef.current?.click()}
          className="size-10 justify-self-center rounded-full"
        >
          {upload.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          aria-label="Avatar file"
          className="sr-only"
          tabIndex={-1}
          disabled={disabled || upload.isPending}
          onChange={handleFile}
        />
      </div>
      {upload.isPending && <p className="text-xs text-muted-foreground">Uploading avatar. Upload pending (backend: builder routes).</p>}
      {fileError && (
        <p role="alert" className="text-xs text-destructive">
          {fileError}
        </p>
      )}
      {upload.isError && (
        <p role="alert" className="text-xs text-destructive">
          Avatar upload failed: {errorText(upload.error)}. The upload endpoint is backend pending.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gradient editor (core gradientPicker)
// ---------------------------------------------------------------------------

interface GradientEditorProps {
  value: string | null;
  disabled: boolean;
  onCommit: (css: string) => void;
}

function GradientEditor({ value, disabled, onCommit }: GradientEditorProps) {
  const [gs, setGs] = useState<GradientState>(() => (value ? parseGradient(value) : null) ?? DEFAULT_GRADIENT);
  // Handlers read the latest state from the ref, so quick pointer moves do not lose updates.
  const gsRef = useRef(gs);
  const lastValue = useRef(value);
  const barRef = useRef<HTMLDivElement>(null);
  const dialRef = useRef<HTMLDivElement>(null);
  const dragEndedAt = useRef(0);

  // A saved value that changes from outside (draft restored or discarded) replaces the editor state.
  useEffect(() => {
    if (lastValue.current === value) return;
    lastValue.current = value;
    const next = (value ? parseGradient(value) : null) ?? DEFAULT_GRADIENT;
    gsRef.current = next;
    setGs(next);
  }, [value]);

  function apply(next: GradientState) {
    gsRef.current = next;
    setGs(next);
    const css = buildGradient(next);
    lastValue.current = css;
    onCommit(css);
  }

  function setType(type: GradientType) {
    apply({ ...gsRef.current, type });
  }

  function setAngle(raw: string) {
    const n = Number(raw);
    if (raw.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 360) apply({ ...gsRef.current, angle: n });
  }

  function setStop(index: number, patch: Partial<GradientStop>) {
    const cur = gsRef.current;
    apply({ ...cur, stops: cur.stops.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
  }

  function setStopPosition(index: number, raw: string) {
    const n = Number(raw);
    if (raw.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 100) setStop(index, { position: n });
  }

  function removeStop(index: number) {
    const cur = gsRef.current;
    if (cur.stops.length <= 2) return;
    apply({ ...cur, stops: cur.stops.filter((_, i) => i !== index) });
  }

  function addStop(position: number) {
    const cur = gsRef.current;
    if (cur.stops.length >= MAX_GRADIENT_STOPS) return;
    apply({ ...cur, stops: [...cur.stops, { position, color: colourAt(cur.stops, position) }] });
  }

  function handleBarClick(event: ReactMouseEvent<HTMLDivElement>) {
    // A click that ends a drag does not add a stop.
    if (disabled || Date.now() - dragEndedAt.current < 200 || !barRef.current) return;
    addStop(positionFromX(event.clientX, barRef.current));
  }

  function startStopDrag(index: number, event: ReactPointerEvent<HTMLButtonElement>) {
    const bar = barRef.current;
    if (disabled || !bar) return;
    event.preventDefault();
    event.stopPropagation();
    const move = (e: PointerEvent) => {
      const pos = positionFromX(e.clientX, bar);
      if (gsRef.current.stops[index]?.position !== pos) setStop(index, { position: pos });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      dragEndedAt.current = Date.now();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function nudgeStop(index: number, event: ReactKeyboardEvent<HTMLButtonElement>) {
    const delta = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : 0;
    if (delta === 0 || disabled) return;
    event.preventDefault();
    setStop(index, { position: clamp((gsRef.current.stops[index]?.position ?? 0) + delta, 0, 100) });
  }

  function startAngleDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const dial = dialRef.current;
    if (!dial || disabled || gsRef.current.type !== "linear-gradient") return;
    event.preventDefault();
    const angleFrom = (x: number, y: number) => {
      const rect = dial.getBoundingClientRect();
      const dx = x - (rect.left + rect.width / 2);
      const dy = y - (rect.top + rect.height / 2);
      return (Math.round((Math.atan2(dx, -dy) * 180) / Math.PI) + 360) % 360;
    };
    apply({ ...gsRef.current, angle: angleFrom(event.clientX, event.clientY) });
    const move = (e: PointerEvent) => apply({ ...gsRef.current, angle: angleFrom(e.clientX, e.clientY) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const linear = gs.type === "linear-gradient";
  const css = buildGradient(gs);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <select
          id="customize-gradient-type"
          aria-label="Gradient type"
          value={gs.type}
          disabled={disabled}
          onChange={(e) => setType(e.target.value as GradientType)}
          className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
        >
          <option value="linear-gradient">Linear gradient</option>
          <option value="radial-gradient">Radial gradient</option>
        </select>
        <div
          ref={dialRef}
          role="presentation"
          onPointerDown={startAngleDrag}
          className={cn("relative size-10 shrink-0 select-none rounded-full border", (!linear || disabled) && "pointer-events-none opacity-50")}
        >
          <span className="absolute inset-0" style={{ transform: `rotate(${gs.angle}deg)` }}>
            <span className="absolute left-1/2 top-0.5 size-2 -translate-x-1/2 rounded-full bg-foreground" />
          </span>
        </div>
        <Input
          type="number"
          min={0}
          max={360}
          aria-label="Gradient angle"
          value={gs.angle}
          disabled={disabled || !linear}
          onChange={(e) => setAngle(e.target.value)}
          className="w-20"
        />
      </div>

      <div
        ref={barRef}
        role="presentation"
        onClick={handleBarClick}
        className={cn("relative h-10 w-full cursor-copy rounded-xl border", disabled && "pointer-events-none opacity-60")}
        style={{ backgroundImage: css }}
      >
        {gs.stops.map((stop, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Colour stop ${i + 1} at ${stop.position}%`}
            disabled={disabled}
            onPointerDown={(e) => startStopDrag(i, e)}
            onKeyDown={(e) => nudgeStop(i, e)}
            onClick={(e) => e.stopPropagation()}
            className="absolute top-1/2 h-8 w-4 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full border-2 border-white shadow-lg focus-visible:ring-2 focus-visible:ring-ring"
            style={{ left: `${stop.position}%`, backgroundColor: stop.color }}
          />
        ))}
      </div>

      <div className="space-y-3 rounded-lg border p-4">
        <p className="text-xs font-medium">Colour stops</p>
        {gs.stops.map((stop, i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <CommitTextField
                id={`customize-gradient-stop-${i}`}
                label={`Stop ${i + 1} colour`}
                value={stop.color}
                disabled={disabled}
                placeholder="#FFFFFF"
                mono
                parse={colourParser(false)}
                colourPicker={{ fallback: DEFAULT_ACCENT }}
                onCommit={(hex) => {
                  if (hex) setStop(i, { color: hex });
                }}
              />
            </div>
            <Input
              type="number"
              min={0}
              max={100}
              aria-label={`Stop ${i + 1} position`}
              value={stop.position}
              disabled={disabled}
              onChange={(e) => setStopPosition(i, e.target.value)}
              className="w-20"
            />
            {gs.stops.length > 2 && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Remove colour stop ${i + 1}`}
                disabled={disabled}
                onClick={() => removeStop(i)}
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={disabled || gs.stops.length >= MAX_GRADIENT_STOPS}
          onClick={() => addStop(nextStopPosition(gs.stops))}
        >
          <Plus className="mr-1.5 size-4" />
          Add a colour stop
        </Button>
      </div>

      {value && !parseGradient(value) && (
        <p className="text-xs text-muted-foreground">
          The saved gradient is not in the editor format. It stays until you change it. Current value: {value}
        </p>
      )}
    </div>
  );
}

interface HeaderBackgroundProps {
  value: CustomizeState;
  chatbotId: string | null;
  disabled: boolean;
  onChange: (patch: Partial<CustomizeState>) => void;
}

function HeaderBackground({ value, chatbotId, disabled, onChange }: HeaderBackgroundProps) {
  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Header background type" className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
        {HEADER_OPTIONS.map((option) => {
          const selected = value.headerBgType === option.id;
          return (
            <Button
              key={option.id}
              type="button"
              size="sm"
              role="radio"
              aria-checked={selected}
              variant={selected ? "secondary" : "ghost"}
              disabled={disabled}
              onClick={() => onChange({ headerBgType: option.id })}
            >
              {option.label}
            </Button>
          );
        })}
      </div>

      {value.headerBgType === "color" && (
        <CommitTextField
          id="customize-header-colour"
          label="Header colour"
          value={value.headerBgColor}
          disabled={disabled}
          placeholder="#FFFFFF"
          mono
          parse={colourParser(true)}
          colourPicker={{ fallback: "#FFFFFF" }}
          onCommit={(hex) => onChange({ headerBgColor: hex })}
        />
      )}

      {value.headerBgType === "gradient" && (
        <GradientEditor
          value={value.headerBgGradient}
          disabled={disabled}
          onCommit={(css) => onChange({ headerBgGradient: css })}
        />
      )}

      {value.headerBgType === "image" && (
        <ImageUploadField
          id="customize-header-image"
          label="Upload header image"
          kind="header_bg"
          value={value.headerBgImage}
          chatbotId={chatbotId}
          disabled={disabled}
          onUploaded={(path) => onChange({ headerBgImage: path })}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live preview (schematic, not the core widget)
// ---------------------------------------------------------------------------

const PREVIEW_LINK_CHIPS: Array<{ key: LinkKey; label: string }> = [
  { key: "whatsappLink", label: "WhatsApp" },
  { key: "telegramLink", label: "Telegram" },
  { key: "facebookLink", label: "Facebook" },
  { key: "instagramLink", label: "Instagram" },
  { key: "watchProductTourLink", label: "Product tour" },
];

function headerStyle(v: CustomizeState): CSSProperties {
  if (v.headerBgType === "color" && v.headerBgColor) return { backgroundColor: v.headerBgColor };
  if (v.headerBgType === "gradient" && v.headerBgGradient) return { backgroundImage: v.headerBgGradient };
  if (v.headerBgType === "image" && v.headerBgImage) {
    return { backgroundImage: `url("${imageSrc(v.headerBgImage)}")`, backgroundSize: "cover", backgroundPosition: "center" };
  }
  return {};
}

interface CustomizePreviewProps {
  value: CustomizeState;
  avatarSrc: string | null;
}

function CustomizePreview({ value, avatarSrc }: CustomizePreviewProps) {
  const accent = value.color ?? DEFAULT_ACCENT;
  const triggerPx = triggerSizePx(value.triggerAvatarSize);
  const logoSrc = value.logo ? imageSrc(value.logo) : null;
  const welcomeBg = value.welcomeBgImage ? `url("${imageSrc(value.welcomeBgImage)}")` : undefined;
  const chips = PREVIEW_LINK_CHIPS.filter(({ key }) => value[key]);
  const gdprChips = value.isGdpr
    ? [
        ...(value.privacyPolicyLink ? ["Privacy policy"] : []),
        ...(value.termsOfServiceLink ? ["Terms"] : []),
      ]
    : [];

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium">Preview</p>
      <div
        role="img"
        aria-label="Chatbot preview"
        className={cn(
          "relative flex h-[460px] flex-col justify-end gap-3 overflow-hidden rounded-xl border bg-muted/30 p-4",
          value.position === "left" ? "items-start" : "items-end",
        )}
      >
        <div className="flex w-[240px] flex-col overflow-hidden rounded-2xl bg-white text-black shadow-xl">
          <div className="flex min-h-12 items-center gap-2 p-2" style={headerStyle(value)}>
            {value.showLogo && logoSrc && <img src={logoSrc} alt="" className="h-6 max-w-[96px] object-contain" />}
            <span className="truncate text-xs font-semibold">Chat with us</span>
          </div>

          <div className="flex min-h-[210px] flex-col gap-2 bg-cover bg-center p-3" style={{ backgroundImage: welcomeBg }}>
            {value.showDateAndTime && <p className="text-center text-[10px] text-gray-500">Today, 10:42</p>}
            <div className="flex items-end gap-2">
              {avatarSrc && <img src={avatarSrc} alt="" className="size-6 shrink-0 rounded-full object-cover" />}
              <div className="rounded-xl bg-[#F9F9F9] px-3 py-2 text-xs">Hi, how can we help?</div>
            </div>
            <div className="ms-auto rounded-xl px-3 py-2 text-xs text-white" style={{ backgroundColor: accent }}>
              I have a question
            </div>
            {value.isEmailCollect && (
              <div className="rounded-xl border px-3 py-2 text-xs text-gray-500">Email address</div>
            )}
            {(value.isLinks || value.showSocialLinksInFirstMessage) && chips.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {chips.map((chip) => (
                  <span key={chip.key} className="rounded-xl px-2 py-1 text-[10px]" style={{ color: accent, backgroundColor: `${accent}1A` }}>
                    {chip.label}
                  </span>
                ))}
              </div>
            )}
            {value.isContact && (
              <span className="rounded-xl px-3 py-2 text-center text-xs" style={{ color: accent, backgroundColor: `${accent}1A` }}>
                Contact us
              </span>
            )}
            {value.isArticles && (
              <span className="rounded-xl px-3 py-2 text-center text-xs" style={{ color: accent, backgroundColor: `${accent}1A` }}>
                Help center
              </span>
            )}
            {value.isGdpr && (
              <p className="text-[10px] text-gray-500">
                By chatting you agree to the terms.{gdprChips.length > 0 ? ` ${gdprChips.join(" and ")}.` : ""}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 border-t p-2 text-xs text-gray-500">
            <span className="flex-1 rounded-lg bg-gray-100 px-2 py-1.5">Type a message</span>
            {value.isEmoji && <Smile className="size-4" />}
          </div>
          {value.footerLink && (
            <p className="truncate border-t px-2 py-1 text-center text-[10px]" style={{ color: accent }}>
              {value.footerLink}
            </p>
          )}
        </div>

        <div
          className="flex shrink-0 items-center justify-center overflow-hidden rounded-full shadow-lg"
          style={{
            width: triggerPx,
            height: triggerPx,
            backgroundColor: value.transparentTrigger ? "transparent" : accent,
            color: value.transparentTrigger ? accent : "#FFFFFF",
          }}
        >
          {avatarSrc ? (
            <img src={avatarSrc} alt="" className="size-full object-cover" />
          ) : (
            <MessageCircle style={{ width: triggerPx * 0.5, height: triggerPx * 0.5 }} />
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Schematic preview. The welcome message and title come from the Configure step, and the live widget is not loaded here.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

type SaveState = "idle" | "saving" | "saved" | "failed";

export default function CustomizeStep({ value, onChange, chatbotId, disabled, saveNow }: StepProps<"customize">) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const avatarsQuery = useQuery({
    queryKey: AVATARS_QUERY_KEY,
    // backend pending: builder-routes. GET /api/chatbot/builder/avatars
    queryFn: listBuilderAvatars,
  });
  const avatars = avatarsQuery.data ?? [];
  const avatarSrc = value.avatar
    ? (avatars.find((a) => a.path === value.avatar)?.url ?? imageSrc(value.avatar))
    : null;
  const uploadsBlocked = chatbotId === null;

  const toggle = (key: BooleanKey) => (checked: boolean) => onChange({ [key]: checked } as Partial<CustomizeState>);
  const setLink = (key: LinkKey) => (next: string | null) => onChange({ [key]: next } as Partial<CustomizeState>);

  async function handleSave() {
    setSaveState("saving");
    const ok = await saveNow();
    setSaveState(ok ? "saved" : "failed");
  }

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-8">
        <Alert>
          <AlertDescription>
            Image uploads and the avatar list use builder routes that are backend pending. Colours, options, trigger, position
            and links work now.
          </AlertDescription>
        </Alert>
        {uploadsBlocked && (
          <Alert>
            <AlertDescription>Save the chatbot first. Image uploads need a saved chatbot.</AlertDescription>
          </Alert>
        )}

        <Section title="Images" description="Logo and welcome background. Each upload replaces the current image when it succeeds.">
          <ImageUploadField
            id="customize-logo"
            label="Upload logo"
            kind="logo"
            value={value.logo}
            chatbotId={chatbotId}
            disabled={disabled}
            onUploaded={(path) => onChange({ logo: path })}
          />
          <ImageUploadField
            id="customize-welcome-bg"
            label="Upload welcome background"
            kind="welcome_bg"
            value={value.welcomeBgImage}
            chatbotId={chatbotId}
            disabled={disabled}
            onUploaded={(path) => onChange({ welcomeBgImage: path })}
          />
        </Section>

        <Section title="Avatar" description="Select an avatar for your chatbot.">
          <AvatarPicker
            value={value.avatar}
            avatars={avatars}
            loading={avatarsQuery.isPending}
            loadError={avatarsQuery.isError ? avatarsQuery.error : null}
            disabled={disabled}
            onPick={(path) => onChange({ avatar: path })}
          />
        </Section>

        <Section title="Colour" description="Choose an accent colour that represents your brand. Empty uses the default blue.">
          <div role="radiogroup" aria-label="Accent colour" className="flex flex-wrap gap-3">
            {PRESET_COLORS.map((color) => {
              const selected = value.color?.toUpperCase() === color;
              return (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`Colour ${color}`}
                  disabled={disabled}
                  onClick={() => onChange({ color })}
                  className={cn(
                    "size-10 rounded-full border-[3px] border-background shadow-md transition hover:scale-110 disabled:opacity-50",
                    selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
                  )}
                  style={{ backgroundColor: color }}
                />
              );
            })}
          </div>
          <CommitTextField
            id="customize-accent-colour"
            label="Custom colour"
            value={value.color}
            disabled={disabled}
            placeholder="#017BE5"
            mono
            parse={colourParser(true)}
            colourPicker={{ fallback: DEFAULT_ACCENT }}
            onCommit={(hex) => onChange({ color: hex })}
          />
        </Section>

        <Section title="Header background">
          <HeaderBackground value={value} chatbotId={chatbotId} disabled={disabled} onChange={onChange} />
        </Section>

        <Section title="Options">
          <div className="divide-y">
            {TOGGLES.map((t) => (
              <ToggleRow
                key={t.key}
                id={`customize-${t.key}`}
                label={t.label}
                hint={t.hint}
                checked={value[t.key]}
                disabled={disabled}
                onCheckedChange={toggle(t.key)}
              />
            ))}
          </div>
        </Section>

        <Section title="Trigger" description="The round button that opens the window.">
          <ToggleRow
            id="customize-transparentTrigger"
            label="Transparent trigger"
            hint="If on, the trigger is transparent when idle. It gets a background when active, so it stays visible."
            checked={value.transparentTrigger}
            disabled={disabled}
            onCheckedChange={toggle("transparentTrigger")}
          />
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Trigger avatar size</span>
              <span className="text-xs font-medium">{triggerSizePx(value.triggerAvatarSize)}px</span>
            </div>
            <Slider
              aria-label="Trigger avatar size"
              min={TRIGGER_MIN}
              max={TRIGGER_MAX}
              step={1}
              disabled={disabled}
              value={[triggerSizePx(value.triggerAvatarSize)]}
              onValueChange={([n]) => onChange({ triggerAvatarSize: `${n}px` })}
            />
          </div>
        </Section>

        <Section title="Position" description="Which side of the page the chatbot sits on.">
          <div role="radiogroup" aria-label="Position" className="grid grid-cols-2 gap-3">
            {POSITIONS.map((p) => {
              const selected = value.position === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  onClick={() => onChange({ position: p.id })}
                  className={cn(
                    "flex h-24 flex-col justify-between rounded-lg border p-3 text-left text-xs font-medium transition disabled:opacity-50",
                    selected ? "border-primary bg-primary/5" : "hover:bg-muted",
                  )}
                >
                  <span className={cn("flex h-10 w-full", p.id === "right" ? "justify-end" : "justify-start")}>
                    <span className="size-5 rounded-full bg-foreground/30" />
                  </span>
                  {p.label}
                </button>
              );
            })}
          </div>
        </Section>

        <Section title="Links" description="Each link is optional. Links must start with https:// or http://.">
          <div className="space-y-4">
            {LINK_ROWS.map((row) => (
              <CommitTextField
                key={row.key}
                id={`customize-${row.key}`}
                label={row.label}
                value={value[row.key]}
                disabled={disabled}
                placeholder={row.placeholder}
                parse={parseLink}
                onCommit={setLink(row.key)}
              />
            ))}
            {value.isGdpr &&
              GDPR_LINK_ROWS.map((row) => (
                <CommitTextField
                  key={row.key}
                  id={`customize-${row.key}`}
                  label={row.label}
                  value={value[row.key]}
                  disabled={disabled}
                  placeholder={row.placeholder}
                  parse={parseLink}
                  onCommit={setLink(row.key)}
                />
              ))}
          </div>
        </Section>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void handleSave()} disabled={disabled || saveState === "saving"}>
            {saveState === "saving" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
            {saveState === "saving" ? "Saving..." : "Save this step"}
          </Button>
          {saveState === "saved" && (
            <p role="status" className="text-xs text-muted-foreground">
              Saved.
            </p>
          )}
          {saveState === "failed" && (
            <p role="alert" className="text-xs text-destructive">
              Not saved. The error is shown above the steps.
            </p>
          )}
        </div>
      </div>

      <aside className="xl:sticky xl:top-4 xl:self-start">
        <CustomizePreview value={value} avatarSrc={avatarSrc} />
      </aside>
    </div>
  );
}
