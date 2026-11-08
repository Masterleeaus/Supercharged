import { Badge } from "@/components/ui/badge";
import type { ProviderSupport } from "@/lib/languages";

interface LanguageProviderBadgesProps {
  providers: ProviderSupport;
  compact?: boolean;
}

export function LanguageProviderBadges({ providers, compact = false }: LanguageProviderBadgesProps) {
  const showElevenLabs = providers.includes("elevenlabs");
  const showOpenAI = providers.includes("openai");
  const showDeepgram = providers.includes("deepgram");
  
  return (
    <span className="inline-flex gap-1 ml-2">
      {showElevenLabs && (
        <Badge 
          variant="outline" 
          className="bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700"
          data-testid="badge-provider-elevenlabs"
        >
          {compact ? "EL" : "ElevenLabs"}
        </Badge>
      )}
      {showOpenAI && (
        <Badge 
          variant="outline" 
          className="bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700"
          data-testid="badge-provider-openai"
        >
          {compact ? "OA" : "OpenAI"}
        </Badge>
      )}
      {showDeepgram && (
        <Badge 
          variant="outline" 
          className="bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700"
          data-testid="badge-provider-deepgram"
        >
          {compact ? "DG" : "Deepgram"}
        </Badge>
      )}
    </span>
  );
}

interface LanguageOptionLabelProps {
  label: string;
  providers: ProviderSupport;
  compact?: boolean;
}

export function LanguageOptionLabel({ label, providers, compact = false }: LanguageOptionLabelProps) {
  return (
    <span className="flex items-center justify-between w-full">
      <span>{label}</span>
      <LanguageProviderBadges providers={providers} compact={compact} />
    </span>
  );
}
