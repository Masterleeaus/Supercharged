/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Play, Pause, Square, Loader2, Volume2, Settings2, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { AuthStorage } from "@/lib/auth-storage";
import { useTranslation } from "react-i18next";

interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  speed: number;
}

interface VoicePreviewButtonProps {
  voiceId: string | null;
  voiceName?: string;
  voiceSettings?: VoiceSettings;
  onSettingsChange?: (settings: VoiceSettings) => void;
  compact?: boolean;
  previewText?: string;
  language?: string;
}

export type { VoicePreviewButtonProps, VoiceSettings };

const defaultSettings: VoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.75,
  speed: 1.0,
};

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


async function fetchVoicePreview(
  voiceId: string,
  text: string,
  voiceSettings: VoiceSettings,
  language?: string
): Promise<Blob> {
  const authHeader = AuthStorage.getAuthHeader();
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  const response = await fetch("/api/voices/preview", {
    method: "POST",
    headers,
    body: JSON.stringify({
      voiceId,
      text,
      voiceSettings,
      language,
    }),
  });

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

export default function VoicePreviewButton({
  voiceId,
  voiceName,
  voiceSettings = defaultSettings,
  onSettingsChange,
  compact = false,
  previewText: initialPreviewText,
  language,
}: VoicePreviewButtonProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
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
  const [previewText, setPreviewText] = useState(initialPreviewText || defaultText);
  const [localSettings, setLocalSettings] = useState<VoiceSettings>(voiceSettings);

  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  useEffect(() => {
    setPreviewText(initialPreviewText || defaultText);
  }, [initialPreviewText, defaultText]);

  useEffect(() => {
    setLocalSettings(voiceSettings);
  }, [voiceSettings]);

  const playAudio = useCallback(async (url: string) => {
    if (audioRef.current) {
      audioRef.current.src = url;
      audioRef.current.load();
      await audioRef.current.play();
      setIsPlaying(true);
    }
  }, []);

  const generatePreview = async () => {
    if (!voiceId) {
      toast({
        title: t('voicePreview.noVoiceSelected'),
        description: t('voicePreview.pleaseSelectVoice'),
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    setIsPlaying(false);

    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }

    try {
      const sanitizedText = sanitizeTextForPreview(previewText, language);
      const blob = await fetchVoicePreview(voiceId, sanitizedText, localSettings, language);
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      await playAudio(url);
    } catch (error: any) {
      console.error("Voice preview error:", error);
      toast({
        title: t('voicePreview.error'),
        description: error.message || t('voicePreview.failedToGenerate'),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const togglePlayback = () => {
    if (!audioRef.current || !audioUrl) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const stopPlayback = () => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    audioRef.current.currentTime = 0;
    setIsPlaying(false);
  };

  const handleAudioEnded = () => {
    setIsPlaying(false);
  };

  const updateSetting = (key: keyof VoiceSettings, value: number) => {
    const newSettings = { ...localSettings, [key]: value };
    setLocalSettings(newSettings);
    onSettingsChange?.(newSettings);
  };

  const quickPreview = async () => {
    if (!voiceId) {
      toast({
        title: t('voicePreview.noVoiceSelected'),
        description: t('voicePreview.pleaseSelectVoice'),
        variant: "destructive",
      });
      return;
    }
    
    setIsLoading(true);
    try {
      const sanitizedText = sanitizeTextForPreview(previewText, language);
      const blob = await fetchVoicePreview(voiceId, sanitizedText, localSettings, language);
      const url = URL.createObjectURL(blob);
      
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
      setAudioUrl(url);
      await playAudio(url);
    } catch (error: any) {
      console.error("Voice preview error:", error);
      toast({
        title: t('voicePreview.error'),
        description: error.message || t('voicePreview.failedToGenerate'),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (compact) {
    return (
      <>
        <audio ref={audioRef} onEnded={handleAudioEnded} />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={audioUrl && isPlaying ? stopPlayback : quickPreview}
          disabled={!voiceId || isLoading}
          data-testid="button-voice-preview-compact"
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

  return (
    <>
      <audio ref={audioRef} onEnded={handleAudioEnded} />
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!voiceId}
            data-testid="button-voice-preview"
          >
            <Settings2 className="h-4 w-4 mr-2" />
            {t('voicePreview.previewSettings')}
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('voicePreview.title')}</DialogTitle>
            <DialogDescription>
              {voiceName ? t('voicePreview.adjustSettingsFor', { name: voiceName }) : t('voicePreview.adjustSettings')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">
            <div className="space-y-2">
              <Label htmlFor="preview-text">{t('voicePreview.previewText')} ({t('agents.create.firstMessage', 'Agent First Message')})</Label>
              <Textarea
                id="preview-text"
                value={previewText}
                onChange={(e) => setPreviewText(e.target.value)}
                placeholder={t('voicePreview.enterText')}
                rows={3}
                maxLength={500}
                data-testid="textarea-preview-text"
              />
              <p className="text-xs text-muted-foreground">
                {previewText.length}/500 {t('voicePreview.characters')}
              </p>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('voicePreview.stability')}</Label>
                  <span className="text-sm text-muted-foreground">{Math.round(localSettings.stability * 100)}%</span>
                </div>
                <Slider
                  value={[localSettings.stability]}
                  onValueChange={([v]) => updateSetting("stability", v)}
                  min={0}
                  max={1}
                  step={0.05}
                  data-testid="slider-stability"
                />
                <p className="text-xs text-muted-foreground">{t('voicePreview.stabilityHelp')}</p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('voicePreview.similarityBoost')}</Label>
                  <span className="text-sm text-muted-foreground">{Math.round(localSettings.similarity_boost * 100)}%</span>
                </div>
                <Slider
                  value={[localSettings.similarity_boost]}
                  onValueChange={([v]) => updateSetting("similarity_boost", v)}
                  min={0}
                  max={1}
                  step={0.05}
                  data-testid="slider-similarity"
                />
                <p className="text-xs text-muted-foreground">{t('voicePreview.similarityHelp')}</p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('voicePreview.speed')}</Label>
                  <span className="text-sm text-muted-foreground">{localSettings.speed.toFixed(2)}x</span>
                </div>
                <Slider
                  value={[localSettings.speed]}
                  onValueChange={([v]) => updateSetting("speed", v)}
                  min={0.7}
                  max={1.2}
                  step={0.05}
                  data-testid="slider-speed"
                />
                <p className="text-xs text-muted-foreground">{t('voicePreview.speedHelp')}</p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 pt-2 border-t">
              <div className="flex gap-2">
                {audioUrl && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={togglePlayback}
                      data-testid="button-toggle-playback"
                    >
                      {isPlaying ? (
                        <>
                          <Pause className="h-4 w-4 mr-2" />
                          {t('voicePreview.pause')}
                        </>
                      ) : (
                        <>
                          <Play className="h-4 w-4 mr-2" />
                          {t('voicePreview.play')}
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={stopPlayback}
                      data-testid="button-stop"
                    >
                      <Square className="h-4 w-4 mr-2" />
                      {t('voicePreview.stop')}
                    </Button>
                  </>
                )}
              </div>
              <Button
                type="button"
                onClick={generatePreview}
                disabled={isLoading || !previewText.trim()}
                data-testid="button-generate-preview"
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                {audioUrl ? t('voicePreview.regenerate') : t('voicePreview.generate')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
