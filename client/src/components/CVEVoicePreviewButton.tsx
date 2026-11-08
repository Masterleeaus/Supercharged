import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Square, Loader2, Volume2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { AuthStorage } from "@/lib/auth-storage";
import { useTranslation } from "react-i18next";

interface CVEVoicePreviewButtonProps {
  voiceId: string | null;
  voiceName?: string;
  previewText?: string;
  provider?: string;
  language?: string;
  ttsModel?: string;
}

async function fetchCVEVoicePreview(
  voiceId: string,
  text: string,
  provider?: string,
  language?: string,
  ttsModel?: string
): Promise<Blob> {
  const isAuthenticated = AuthStorage.isAuthenticated();
  const authHeader = isAuthenticated ? AuthStorage.getAuthHeader() : null;
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  const endpoint = isAuthenticated
    ? "/api/voice-engine/agents/preview"
    : "/api/public/voice-engine/agents/preview";

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      voiceId,
      text,
      provider,
      language,
      ttsModel,
    }),
  });

  // test

  if (!response.ok) {
    let errorMessage = "Failed to generate preview";
    try {
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        const error = await response.json();
        errorMessage = error.error || error.message || errorMessage;
      } else {
        const errorText = await response.text();
        errorMessage = errorText || `Server error: ${response.status}`;
      }
    } catch {
      errorMessage = `Server error: ${response.status} ${response.statusText}`;
    }
    throw new Error(errorMessage);
  }

  return response.blob();
}

const sanitizeTextForPreview = (text: string, lang?: string): string => {
  if (!text) return "";
  
  // Replace template variables with dummy values for a natural preview
  let sanitized = text
    .replace(/\{\{(first_name|last_name|contact_name)\}\}/g, lang === "hi" ? "अतिथि" : "John")
    .replace(/\{\{(company)\}\}/g, lang === "hi" ? "कंपनी" : "our company")
    .replace(/\{\{[^}]+\}\}/g, ""); // Remove any other curly brace variables

  // Fix exclamation marks in Hindi or other languages that might cause TTS to choke
  if (lang === "hi" || /[\u0900-\u097F]/.test(sanitized)) {
    sanitized = sanitized.replace(/!/g, "।");
  } else {
    sanitized = sanitized.replace(/!/g, ".");
  }
  
  return sanitized;
};

export default function CVEVoicePreviewButton({
  voiceId,
  voiceName,
  previewText,
  provider,
  language,
  ttsModel,
}: CVEVoicePreviewButtonProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const previewTexts: Record<string, string> = {
    "en": "Hello! This is a preview of how I'll sound. I can adjust my tone and style based on your preferences.",
    "hi": "नमस्ते! यह एक पूर्वावलोकन है कि मैं कैसा लगूंगा। मैं आपकी पसंद के अनुसार अपना लहजा और शैली बदल सकता हूँ।",
    "bn": "নমস্কার! এটি একটি পূর্বরূপ যে আমাকে কেমন শোনাবে। আপনি চাইলে আমি আমার বলার ধরন পরিবর্তন করতে পারি।",
    "ta": "வணக்கம்! நான் எப்படி ஒலிப்பேன் என்பதற்கான முன்னோட்டம் இது. உங்கள் விருப்பங்களுக்கு ஏற்ப எனது தொனியை மாற்றிக்கொள்ள முடியும்.",
    "te": "నమస్కారం! నేను ఎలా ఉంటానో ఇది ఒక ప్రివ్యూ. మీరు కోరిన విధంగా నా స్వరాన్ని మార్చుకోగలను.",
    "ml": "നമസ്കാരം! ഞാൻ സംസാരിക്കുന്നത് എങ്ങനെയുണ്ടെന്ന് കേൾക്കാം. നിങ്ങളുടെ ഇഷ്ടാനുസരണം എന്റെ ശബ്ദത്തിൽ മാറ്റങ്ങൾ വരുത്താം.",
    "mr": "नमस्कार! मी कसा आवाज देईन याचा हा एक प्रीव्ह्यू आहे. मी तुमच्या पसंतीनुसार माझा टोन बदलू शकतो.",
    "gu": "નમસ્તે! હું કેવો અવાજ આપીશ તેનો આ પૂર્વાવલોકન છે.",
    "pa": "ਸਤਿ ਸ਼੍ਰੀ ਅਕਾਲ! ਇਹ ਮੇਰੀ ਆਵਾਜ਼ ਦਾ ਇੱਕ ਨਮੂਨਾ ਹੈ।",
    "kn": "ನಮಸ್ಕಾರ! ನಾನು ಹೇಗೆ ಧ್ವನಿಸುತ್ತೇನೆ ಎಂಬುದರ ಮುನ್ನೋಟ ಇದು.",
    "or": "ନମସ୍କାର! ମୋର ସ୍ୱର କିପରି ଶୁଣାଯିବ, ଏହା ତାର ଏକ ଉଦାହରଣ ।"
  };

  const defaultText = previewTexts[language || "en"] || previewTexts["en"];

  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  const playAudio = useCallback(async (url: string) => {
    if (audioRef.current) {
      audioRef.current.src = url;
      audioRef.current.load();
      await audioRef.current.play();
      setIsPlaying(true);
    }
  }, []);

  const handleAudioEnded = () => {
    setIsPlaying(false);
  };

  const stopPlayback = () => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    audioRef.current.currentTime = 0;
    setIsPlaying(false);
  };

  const quickPreview = async () => {
    if (!voiceId) {
      toast({
        title: t('voicePreview.noVoiceSelected', "No voice selected"),
        description: t('voicePreview.pleaseSelectVoice', "Please select a voice first"),
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      const sanitizedText = sanitizeTextForPreview(previewText || defaultText, language);
      const blob = await fetchCVEVoicePreview(voiceId, sanitizedText, provider, language, ttsModel);
      const url = URL.createObjectURL(blob);

      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
      setAudioUrl(url);
      await playAudio(url);
    } catch (error: any) {
      console.error("CVE voice preview error:", error);
      toast({
        title: t('voicePreview.error', "Preview Error"),
        description: error.message || t('voicePreview.failedToGenerate', "Failed to generate preview"),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <audio ref={audioRef} onEnded={handleAudioEnded} />
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={audioUrl && isPlaying ? stopPlayback : quickPreview}
        disabled={!voiceId || isLoading}
        data-testid="button-cve-voice-preview"
        title={voiceName ? `Preview ${voiceName}` : "Preview voice"}
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : isPlaying ? (
          <Square className="h-4 w-4" />
        ) : (
          <Volume2 className="h-4 w-4" />
        )}
      </Button>
    </>
  );
}
