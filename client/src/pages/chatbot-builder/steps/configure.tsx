/**
 * Configure step of the chatbot builder wizard (core: edit-step-configure.blade.php).
 *
 * Reads its group from props.value and writes every change through props.onChange. The shell saves with
 * props.saveNow, so this file never sends a PATCH. The one direct call is the promo banner upload, because
 * uploads need a saved chatbot id.
 *
 * Validation: the four required fields and their length limits match the shell's validateConfigure. The
 * banner, link and suggested-prompt checks follow endpoint-map.md section 4. They are shown inline only.
 */
import { useState, type ChangeEvent, type ReactNode } from "react";
import { ApiError } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { SUPPORTED_LANGUAGES } from "@/lib/languages";
import { uploadBuilderImage } from "../api";
import {
  BUBBLE_DESIGNS,
  BUILDER_LIMITS,
  LANGUAGE_AUTO,
  type BubbleDesign,
  type ConfigureState,
  type StepProps,
  type SuggestedPrompt,
} from "../types";

/** Max length of a banner link. From endpoint-map.md section 4 (the backend limit for link fields). */
const LINK_MAX = 2048;

const BUBBLE_DESIGN_LABELS: Record<BubbleDesign, string> = {
  blank: "Blank",
  plain: "Plain",
  links: "Links",
  modern: "Modern",
  suggestions: "Suggestions",
  promo_banner: "Promo Banner",
};

type ErrorKey =
  | "title"
  | "bubbleMessage"
  | "welcomeMessage"
  | "instructions"
  | "promoBannerTitle"
  | "promoBannerDescription"
  | "promoBannerButtonLabel"
  | "promoBannerButtonLink";

const PROMO_KEYS: ErrorKey[] = [
  "promoBannerTitle",
  "promoBannerDescription",
  "promoBannerButtonLabel",
  "promoBannerButtonLink",
];

interface PromptDialogState {
  /** Index being edited, or null when adding. */
  index: number | null;
  name: string;
  prompt: string;
  error: string | null;
}

/** Empty when valid. Required fields are checked for blank input, and every field for length. */
function textError(label: string, value: string, max: number, required: boolean): string | null {
  if (required && value.trim() === "") return `${label} is required.`;
  if (value.length > max) return `${label} must be ${max} characters or fewer.`;
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function linkError(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (v.length > LINK_MAX) return `Button link must be ${LINK_MAX} characters or fewer.`;
  return isHttpUrl(v) ? null : "Button link must be a full http or https address.";
}

function validate(c: ConfigureState): Record<ErrorKey, string | null> {
  return {
    // The shell trims the title before the length check, so this does the same.
    title: textError("Title", c.title.trim(), BUILDER_LIMITS.title, true),
    bubbleMessage: textError("Bubble message", c.bubbleMessage, BUILDER_LIMITS.bubbleMessage, true),
    welcomeMessage: textError("Welcome message", c.welcomeMessage, BUILDER_LIMITS.welcomeMessage, true),
    // Same wording as the shell's validateConfigure ("are", not "is").
    instructions:
      c.instructions.trim() === ""
        ? "Instructions are required."
        : textError("Instructions", c.instructions, BUILDER_LIMITS.instructions, false),
    promoBannerTitle: textError("Banner title", c.promoBannerTitle, BUILDER_LIMITS.promoBannerTitle, false),
    promoBannerDescription: textError(
      "Banner description",
      c.promoBannerDescription,
      BUILDER_LIMITS.promoBannerDescription,
      false,
    ),
    promoBannerButtonLabel: textError(
      "Button label",
      c.promoBannerButtonLabel,
      BUILDER_LIMITS.promoBannerButtonLabel,
      false,
    ),
    promoBannerButtonLink: linkError(c.promoBannerButtonLink),
  };
}

function FieldError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return <p className="mt-2 text-xs font-medium text-destructive">{message}</p>;
}

/** Label, control and inline error, stacked. The label points at the control's id. */
function Field(props: { id: string; label: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
      <FieldError message={props.error} />
    </div>
  );
}

function SwitchRow(props: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label htmlFor={props.id} className="text-sm font-medium">
        {props.label}
      </Label>
      <Switch
        id={props.id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onCheckedChange}
      />
    </div>
  );
}

export default function ConfigureStep({ value: c, onChange, chatbotId, disabled }: StepProps<"configure">) {
  // A field shows its error only after the user has left it, so an empty new form is not all red.
  const [touched, setTouched] = useState<Partial<Record<ErrorKey, boolean>>>({});
  const [promoOpen, setPromoOpen] = useState(false);
  const [promptDialog, setPromptDialog] = useState<PromptDialogState | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  // Preview URL from the last successful upload. Loaded values only have the stored path.
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);

  const errors = validate(c);
  const shownError = (key: ErrorKey) => (touched[key] ? errors[key] : null);

  function touch(keys: ErrorKey[]) {
    setTouched((prev) => {
      const next = { ...prev };
      for (const key of keys) next[key] = true;
      return next;
    });
  }

  const languageOptions = [
    { value: LANGUAGE_AUTO, label: "Auto" },
    ...SUPPORTED_LANGUAGES.map((l) => ({ value: l.value, label: l.label })),
  ];
  // Keep a loaded value that is not in the list visible, so the select does not go blank.
  if (c.language !== LANGUAGE_AUTO && !SUPPORTED_LANGUAGES.some((l) => l.value === c.language)) {
    languageOptions.push({ value: c.language, label: c.language });
  }

  // ---- Suggested prompts (core: openSuggestedPromptModal, saveSuggestedPrompt, removeSuggestedPrompt) ----

  function openPromptDialog(index: number | null) {
    const existing = index === null ? undefined : c.suggestedPrompts[index];
    setPromptDialog({ index, name: existing?.name ?? "", prompt: existing?.prompt ?? "", error: null });
  }

  function toggleSuggestedPrompts(enabled: boolean) {
    if (enabled) {
      onChange({ suggestedPromptsEnabled: true });
      // Core opens the add dialog straight away when the list is empty.
      if (c.suggestedPrompts.length === 0) openPromptDialog(null);
    } else {
      // Core clears the list when the switch is turned off.
      onChange({ suggestedPromptsEnabled: false, suggestedPrompts: [] });
    }
  }

  function savePrompt() {
    if (!promptDialog) return;
    const name = promptDialog.name.trim();
    const prompt = promptDialog.prompt.trim();
    const fail = (error: string) => setPromptDialog({ ...promptDialog, error });

    if (!name && !prompt) return fail("Please provide at least a prompt name or the prompt itself.");
    if (name.length > BUILDER_LIMITS.suggestedPromptName) {
      return fail(`Prompt name must be ${BUILDER_LIMITS.suggestedPromptName} characters or fewer.`);
    }
    if (prompt.length > BUILDER_LIMITS.suggestedPromptText) {
      return fail(`Prompt must be ${BUILDER_LIMITS.suggestedPromptText} characters or fewer.`);
    }
    if (promptDialog.index === null && c.suggestedPrompts.length >= BUILDER_LIMITS.suggestedPrompts) {
      return fail(`You can add up to ${BUILDER_LIMITS.suggestedPrompts} suggested prompts.`);
    }

    const entry: SuggestedPrompt = { name, prompt };
    const next =
      promptDialog.index === null
        ? [...c.suggestedPrompts, entry]
        : c.suggestedPrompts.map((p, i) => (i === promptDialog.index ? entry : p));
    // Core: the switch is on while at least one prompt exists.
    onChange({ suggestedPrompts: next, suggestedPromptsEnabled: next.length > 0 });
    setPromptDialog(null);
  }

  function removePrompt(index: number) {
    const next = c.suggestedPrompts.filter((_, i) => i !== index);
    // Core: removing the last prompt turns the switch off.
    onChange({
      suggestedPrompts: next,
      suggestedPromptsEnabled: next.length > 0 ? c.suggestedPromptsEnabled : false,
    });
  }

  // ---- Promo banner image (core: x-modal file input, uploaded on save) ----

  const canUpload = chatbotId !== null && !disabled && !uploading;

  async function handleBannerFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Clear the input so picking the same file again still fires onChange.
    event.target.value = "";
    if (!file || chatbotId === null) return;

    if (!file.type.startsWith("image/")) {
      setUploadError("Choose an image file.");
      return;
    }
    if (file.size > BUILDER_LIMITS.uploadBytes) {
      setUploadError("Image must be 4 MB or smaller.");
      return;
    }

    setUploadError(null);
    setUploadNote(null);
    setUploading(true);
    try {
      const uploaded = await uploadBuilderImage(chatbotId, "promo_banner", file);
      setBannerPreview(uploaded.url);
      // The path is stored with the next save, not here.
      onChange({ promoBannerImage: uploaded.path });
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) {
        setUploadNote("Saved on backend when builder routes ship.");
      } else {
        setUploadError(err instanceof Error ? err.message : "Upload failed.");
      }
    } finally {
      setUploading(false);
    }
  }

  const bannerSrc = bannerPreview ?? c.promoBannerImage;

  // Save Settings only closes the dialog when the banner fields are valid. Core simply closed it.
  function closePromoDialog() {
    touch(PROMO_KEYS);
    const hasPromoError = PROMO_KEYS.some((key) => errors[key] !== null);
    if (!hasPromoError) setPromoOpen(false);
  }

  return (
    <div className="space-y-7">
      <p className="text-xs/5 text-muted-foreground">
        Create and configure a chatbot that interacts with your users, ensuring it delivers accurate information.
      </p>

      <Field id="configure-title" label="Chatbot title" error={shownError("title")}>
        <Input
          id="configure-title"
          placeholder="MagicBot"
          value={c.title}
          disabled={disabled}
          onChange={(e) => onChange({ title: e.target.value })}
          onBlur={() => touch(["title"])}
        />
      </Field>

      <Field id="configure-bubble-message" label="Bubble message" error={shownError("bubbleMessage")}>
        <Input
          id="configure-bubble-message"
          placeholder="MagicBot"
          value={c.bubbleMessage}
          disabled={disabled}
          onChange={(e) => onChange({ bubbleMessage: e.target.value })}
          onBlur={() => touch(["bubbleMessage"])}
        />
      </Field>

      <Field id="configure-bubble-design" label="Bubble design">
        <Select
          value={c.bubbleDesign}
          disabled={disabled}
          onValueChange={(v) => onChange({ bubbleDesign: v as BubbleDesign })}
        >
          <SelectTrigger id="configure-bubble-design">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BUBBLE_DESIGNS.map((design) => (
              <SelectItem key={design} value={design}>
                {BUBBLE_DESIGN_LABELS[design]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {c.bubbleDesign === "promo_banner" && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 text-xs font-medium">Promo banner settings</p>
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={disabled}
            onClick={() => setPromoOpen(true)}
          >
            Configure
          </Button>
        </div>
      )}

      <Field id="configure-welcome" label="Welcome message" error={shownError("welcomeMessage")}>
        <Input
          id="configure-welcome"
          placeholder="Enter welcome message"
          value={c.welcomeMessage}
          disabled={disabled}
          onChange={(e) => onChange({ welcomeMessage: e.target.value })}
          onBlur={() => touch(["welcomeMessage"])}
        />
      </Field>

      <Field id="configure-instructions" label="Chatbot instructions" error={shownError("instructions")}>
        <Textarea
          id="configure-instructions"
          rows={4}
          placeholder="Explain chatbot role"
          value={c.instructions}
          disabled={disabled}
          onChange={(e) => onChange({ instructions: e.target.value })}
          onBlur={() => touch(["instructions"])}
        />
      </Field>

      <SwitchRow
        id="configure-do-not-go-beyond"
        label="Do not go beyond instructions"
        checked={c.doNotGoBeyondInstructions}
        disabled={disabled}
        onCheckedChange={(checked) => onChange({ doNotGoBeyondInstructions: checked })}
      />

      <div className="space-y-3">
        <SwitchRow
          id="configure-suggested-prompts"
          label="Suggested prompts and questions"
          checked={c.suggestedPromptsEnabled}
          disabled={disabled}
          onCheckedChange={toggleSuggestedPrompts}
        />

        {c.suggestedPromptsEnabled && (
          <div className="space-y-3 rounded-lg border p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Suggested prompts and questions</h3>
                <p className="mt-1 text-xs/5 text-muted-foreground">
                  Provide quick starter prompts your assistant can suggest to users.
                </p>
              </div>
              <Button
                size="sm"
                type="button"
                disabled={disabled || c.suggestedPrompts.length >= BUILDER_LIMITS.suggestedPrompts}
                onClick={() => openPromptDialog(null)}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                Add prompt
              </Button>
            </div>

            {c.suggestedPrompts.length === 0 && (
              <div className="rounded-md border border-dashed p-4 text-xs/6 text-muted-foreground">
                No prompts added yet. Add one to get started.
              </div>
            )}

            {c.suggestedPrompts.map((item, index) => (
              <div key={index} className="space-y-2 rounded-md border p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold">{item.name.trim() || "Untitled prompt"}</p>
                    <p className="mt-1 text-xs/5 text-muted-foreground">
                      {item.prompt.trim() || "No prompt provided"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      type="button"
                      title="Edit prompt"
                      aria-label={`Edit prompt ${index + 1}`}
                      disabled={disabled}
                      onClick={() => openPromptDialog(index)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      type="button"
                      title="Remove prompt"
                      aria-label={`Remove prompt ${index + 1}`}
                      disabled={disabled}
                      onClick={() => removePrompt(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Field id="configure-language" label="Language">
        <Select
          value={c.language}
          disabled={disabled}
          onValueChange={(language) => onChange({ language })}
        >
          <SelectTrigger id="configure-language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {languageOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {/* Promo banner dialog (core: x-modal with the banner fields). */}
      <Dialog open={promoOpen} onOpenChange={(open) => (open ? setPromoOpen(true) : closePromoDialog())}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Promo banner</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Configure the promotional banner that appears above the trigger button.
          </p>

          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="configure-banner-file">Banner image</Label>
              <Input
                id="configure-banner-file"
                type="file"
                accept="image/*"
                disabled={!canUpload}
                onChange={(e) => void handleBannerFile(e)}
              />
              {chatbotId === null && (
                <p className="text-xs text-muted-foreground">Save the chatbot first to upload a banner image.</p>
              )}
              {uploading && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Uploading...
                </p>
              )}
              {uploadError && <FieldError message={uploadError} />}
              {uploadNote && (
                <Alert>
                  <AlertDescription>{uploadNote}</AlertDescription>
                </Alert>
              )}
              {bannerSrc && (
                <div className="mt-2 overflow-hidden">
                  <img
                    className="h-[155px] w-[min(280px,100%)] rounded-lg object-cover"
                    src={bannerSrc}
                    alt=""
                  />
                </div>
              )}
            </div>

            <Field id="configure-promo-title" label="Title" error={shownError("promoBannerTitle")}>
              <Input
                id="configure-promo-title"
                placeholder="Claim your discount"
                value={c.promoBannerTitle}
                disabled={disabled}
                onChange={(e) => onChange({ promoBannerTitle: e.target.value })}
                onBlur={() => touch(["promoBannerTitle"])}
              />
            </Field>

            <Field id="configure-promo-description" label="Description" error={shownError("promoBannerDescription")}>
              <Textarea
                id="configure-promo-description"
                rows={3}
                placeholder="For a limited time, enjoy massive discounts across our entire store."
                value={c.promoBannerDescription}
                disabled={disabled}
                onChange={(e) => onChange({ promoBannerDescription: e.target.value })}
                onBlur={() => touch(["promoBannerDescription"])}
              />
            </Field>

            <Field id="configure-promo-btn-label" label="Button label" error={shownError("promoBannerButtonLabel")}>
              <Input
                id="configure-promo-btn-label"
                placeholder="View offer"
                value={c.promoBannerButtonLabel}
                disabled={disabled}
                onChange={(e) => onChange({ promoBannerButtonLabel: e.target.value })}
                onBlur={() => touch(["promoBannerButtonLabel"])}
              />
            </Field>

            <Field id="configure-promo-btn-link" label="Button link" error={shownError("promoBannerButtonLink")}>
              <Input
                id="configure-promo-btn-link"
                placeholder="https://example.com/offer"
                value={c.promoBannerButtonLink}
                disabled={disabled}
                onChange={(e) => onChange({ promoBannerButtonLink: e.target.value })}
                onBlur={() => touch(["promoBannerButtonLink"])}
              />
            </Field>
          </div>

          <DialogFooter>
            <Button type="button" className="w-full" variant="secondary" onClick={closePromoDialog}>
              Save settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Suggested prompt dialog (core: suggestedPromptModal). */}
      <Dialog
        open={promptDialog !== null}
        onOpenChange={(open) => {
          if (!open) setPromptDialog(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {promptDialog?.index === null ? "Add suggested prompt" : "Edit suggested prompt"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="configure-prompt-name">Prompt name</Label>
              <Input
                id="configure-prompt-name"
                placeholder="Example: Pricing"
                value={promptDialog?.name ?? ""}
                onChange={(e) =>
                  setPromptDialog((d) => (d ? { ...d, name: e.target.value, error: null } : d))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="configure-prompt-text">Prompt</Label>
              <Textarea
                id="configure-prompt-text"
                rows={4}
                placeholder="Example: How much does the premium plan cost?"
                value={promptDialog?.prompt ?? ""}
                onChange={(e) =>
                  setPromptDialog((d) => (d ? { ...d, prompt: e.target.value, error: null } : d))
                }
              />
            </div>
            {promptDialog?.error && (
              <Alert variant="destructive">
                <AlertDescription>{promptDialog.error}</AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter className="gap-3">
            <Button type="button" variant="outline" onClick={() => setPromptDialog(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={savePrompt}>
              {promptDialog?.index === null ? "Add prompt" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
