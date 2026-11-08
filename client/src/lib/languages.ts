export type ProviderSupport = string[];

export interface LanguageOption {
  value: string;
  label: string;
  providers: ProviderSupport;
}

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { value: "af", label: "Afrikaans", providers: ["elevenlabs","openai","deepgram"] },
  { value: "ar", label: "Arabic", providers: ["elevenlabs","openai","deepgram"] },
  { value: "hy", label: "Armenian", providers: ["elevenlabs","deepgram"] },
  { value: "as", label: "Assamese", providers: ["elevenlabs"] },
  { value: "az", label: "Azerbaijani", providers: ["elevenlabs"] },
  { value: "be", label: "Belarusian", providers: ["elevenlabs"] },
  { value: "bn", label: "Bengali", providers: ["elevenlabs","openai","deepgram"] },
  { value: "bs", label: "Bosnian", providers: ["elevenlabs","deepgram"] },
  { value: "bg", label: "Bulgarian", providers: ["elevenlabs","openai","deepgram"] },
  { value: "ca", label: "Catalan", providers: ["elevenlabs","openai","deepgram"] },
  { value: "ceb", label: "Cebuano", providers: ["elevenlabs"] },
  { value: "ny", label: "Chichewa", providers: ["elevenlabs"] },
  { value: "zh", label: "Chinese", providers: ["elevenlabs", "openai"] },
  { value: "hr", label: "Croatian", providers: ["elevenlabs","openai","deepgram"] },
  { value: "cs", label: "Czech", providers: ["elevenlabs","openai","deepgram"] },
  { value: "da", label: "Danish", providers: ["elevenlabs","openai","deepgram"] },
  { value: "nl", label: "Dutch", providers: ["elevenlabs","openai","deepgram"] },
  { value: "en", label: "English", providers: ["elevenlabs","openai","deepgram"] },
  { value: "et", label: "Estonian", providers: ["elevenlabs","openai","deepgram"] },
  { value: "fil", label: "Filipino", providers: ["elevenlabs", "openai"] },
  { value: "fi", label: "Finnish", providers: ["elevenlabs","openai","deepgram"] },
  { value: "fr", label: "French", providers: ["elevenlabs","openai","deepgram"] },
  { value: "gl", label: "Galician", providers: ["elevenlabs","deepgram"] },
  { value: "ka", label: "Georgian", providers: ["elevenlabs","deepgram"] },
  { value: "de", label: "German", providers: ["elevenlabs","openai","deepgram"] },
  { value: "el", label: "Greek", providers: ["elevenlabs","openai","deepgram"] },
  { value: "gu", label: "Gujarati", providers: ["elevenlabs","openai","deepgram"] },
  { value: "ha", label: "Hausa", providers: ["elevenlabs"] },
  { value: "he", label: "Hebrew", providers: ["elevenlabs","openai","deepgram"] },
  { value: "hi", label: "Hindi", providers: ["elevenlabs","openai","deepgram"] },
  { value: "hu", label: "Hungarian", providers: ["elevenlabs","openai","deepgram"] },
  { value: "is", label: "Icelandic", providers: ["elevenlabs","deepgram"] },
  { value: "id", label: "Indonesian", providers: ["elevenlabs","openai","deepgram"] },
  { value: "ga", label: "Irish", providers: ["elevenlabs"] },
  { value: "it", label: "Italian", providers: ["elevenlabs","openai","deepgram"] },
  { value: "ja", label: "Japanese", providers: ["elevenlabs","openai","deepgram"] },
  { value: "jv", label: "Javanese", providers: ["elevenlabs","deepgram"] },
  { value: "kn", label: "Kannada", providers: ["elevenlabs","openai","deepgram"] },
  { value: "kk", label: "Kazakh", providers: ["elevenlabs","deepgram"] },
  { value: "ky", label: "Kirghiz", providers: ["elevenlabs"] },
  { value: "ko", label: "Korean", providers: ["elevenlabs","openai","deepgram"] },
  { value: "lv", label: "Latvian", providers: ["elevenlabs","openai","deepgram"] },
  { value: "ln", label: "Lingala", providers: ["elevenlabs"] },
  { value: "lt", label: "Lithuanian", providers: ["elevenlabs","openai","deepgram"] },
  { value: "lb", label: "Luxembourgish", providers: ["elevenlabs"] },
  { value: "mk", label: "Macedonian", providers: ["elevenlabs","deepgram"] },
  { value: "ms", label: "Malay", providers: ["elevenlabs","openai","deepgram"] },
  { value: "ml", label: "Malayalam", providers: ["elevenlabs","openai","deepgram"] },
  { value: "mr", label: "Marathi", providers: ["elevenlabs","openai","deepgram"] },
  { value: "ne", label: "Nepali", providers: ["elevenlabs","deepgram"] },
  { value: "no", label: "Norwegian", providers: ["elevenlabs","openai","deepgram"] },
  { value: "ps", label: "Pashto", providers: ["elevenlabs"] },
  { value: "fa", label: "Persian", providers: ["elevenlabs","openai","deepgram"] },
  { value: "pl", label: "Polish", providers: ["elevenlabs","openai","deepgram"] },
  { value: "pt", label: "Portuguese", providers: ["elevenlabs","openai","deepgram"] },
  { value: "pa", label: "Punjabi", providers: ["elevenlabs","openai","deepgram"] },
  { value: "ro", label: "Romanian", providers: ["elevenlabs","openai","deepgram"] },
  { value: "ru", label: "Russian", providers: ["elevenlabs","openai","deepgram"] },
  { value: "sr", label: "Serbian", providers: ["elevenlabs","deepgram"] },
  { value: "sd", label: "Sindhi", providers: ["elevenlabs"] },
  { value: "sk", label: "Slovak", providers: ["elevenlabs","openai","deepgram"] },
  { value: "sl", label: "Slovenian", providers: ["elevenlabs","openai","deepgram"] },
  { value: "so", label: "Somali", providers: ["elevenlabs"] },
  { value: "es", label: "Spanish", providers: ["elevenlabs","openai","deepgram"] },
  { value: "sw", label: "Swahili", providers: ["elevenlabs","openai","deepgram"] },
  { value: "sv", label: "Swedish", providers: ["elevenlabs","openai","deepgram"] },
  { value: "ta", label: "Tamil", providers: ["elevenlabs","openai","deepgram"] },
  { value: "te", label: "Telugu", providers: ["elevenlabs","openai","deepgram"] },
  { value: "th", label: "Thai", providers: ["elevenlabs","openai","deepgram"] },
  { value: "tr", label: "Turkish", providers: ["elevenlabs","openai","deepgram"] },
  { value: "uk", label: "Ukrainian", providers: ["elevenlabs","openai","deepgram"] },
  { value: "ur", label: "Urdu", providers: ["elevenlabs","openai","deepgram"] },
  { value: "vi", label: "Vietnamese", providers: ["elevenlabs","openai","deepgram"] },
  { value: "cy", label: "Welsh", providers: ["elevenlabs","deepgram"] },
];

export function getLanguageLabel(value: string): string {
  const lang = SUPPORTED_LANGUAGES.find(l => l.value === value);
  return lang?.label || value;
}

export function isProviderSupported(value: string, provider: string): boolean {
  const lang = SUPPORTED_LANGUAGES.find(l => l.value === value);
  if (!lang) return false;
  return lang.providers.includes(provider);
}

export function getLanguagesForProvider(provider: string): LanguageOption[] {
  return SUPPORTED_LANGUAGES.filter(lang => 
    lang.providers.includes(provider)
  );
}
