import { useState, useRef, useEffect } from "react";

















import { Globe, Phone, AlertCircle, ChevronDown, Mic, MicOff, PhoneOff, Check } from "lucide-react";


import type { Agent } from "@shared/schema";
import { useTranslation } from "react-i18next";
import { WidgetFormData, CallState } from "./types";

export function InteractiveWidgetPreview({ formData, appName }: { formData: WidgetFormData; appName: string }) {
  const { t } = useTranslation();
  const [callState, setCallState] = useState<CallState>('idle');
  const [timer, setTimer] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (callState === 'active') {
      timerRef.current = setInterval(() => {
        setTimer(t => t + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [callState]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const handleCallClick = () => {
    if (callState === 'idle') {
      if (formData.requireTermsAcceptance) {
        setCallState('terms');
        setTermsAccepted(false);
      } else {
        startConnecting();
      }
    }
  };

  const startConnecting = () => {
    setCallState('connecting');
    setTimeout(() => {
      setCallState('active');
      setTimer(0);
    }, 2000);
  };

  const handleAcceptTerms = () => {
    if (termsAccepted) {
      startConnecting();
    }
  };

  const handleEndCall = () => {
    setCallState('ended');
    setTimeout(() => {
      setCallState('idle');
      setTimer(0);
      setIsMuted(false);
    }, 1500);
  };

  const resetPreview = () => {
    setCallState('idle');
    setTimer(0);
    setIsMuted(false);
    setTermsAccepted(false);
  };

  return (
    <div className="relative h-full min-h-[480px] rounded-xl overflow-hidden border border-border/50 bg-muted/30">
      <div className="h-8 bg-muted flex items-center px-3 gap-2 border-b border-border/50">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-400" />
          <div className="w-3 h-3 rounded-full bg-yellow-400" />
          <div className="w-3 h-3 rounded-full bg-green-400" />
        </div>
        <div className="flex-1 flex justify-center">
          <div className="bg-background/80 rounded-md px-4 py-1 text-[10px] text-muted-foreground flex items-center gap-2 max-w-[200px]">
            <Globe className="h-3 w-3" />
            <span className="truncate">example.com</span>
          </div>
        </div>
        <div className="w-16" />
      </div>

      <div className="relative h-[calc(100%-32px)]">
        <div className="absolute inset-0 bg-gradient-to-br from-slate-100 via-slate-50 to-blue-50 dark:from-slate-900 dark:via-slate-800 dark:to-slate-900">
          <div className="absolute inset-0 opacity-[0.03]" style={{ 
            backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'60\' viewBox=\'0 0 60 60\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cg fill=\'none\' fill-rule=\'evenodd\'%3E%3Cg fill=\'%23000000\' fill-opacity=\'1\'%3E%3Cpath d=\'M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z\'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")'
          }} />
          
          <div className="p-6 space-y-4">
            <div className="h-4 bg-foreground/10 rounded w-3/4" />
            <div className="h-3 bg-foreground/5 rounded w-full" />
            <div className="h-3 bg-foreground/5 rounded w-5/6" />
            <div className="h-3 bg-foreground/5 rounded w-2/3" />
            <div className="grid grid-cols-3 gap-3 mt-6">
              <div className="h-16 bg-foreground/5 rounded-lg" />
              <div className="h-16 bg-foreground/5 rounded-lg" />
              <div className="h-16 bg-foreground/5 rounded-lg" />
            </div>
          </div>
        </div>

        <div className="absolute bottom-4 right-4 left-4 flex justify-end">
          <div className="relative font-sans" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
            <div 
              className="rounded-2xl p-4 min-w-[300px] max-w-[340px] transition-all duration-300"
              style={{ 
                backgroundColor: formData.backgroundColor || '#FFFFFF',
                boxShadow: '0 10px 40px -10px rgba(0,0,0,0.2), 0 0 0 1px rgba(0,0,0,0.05)'
              }}
            >
              {callState === 'terms' ? (
                <div className="space-y-4">
                  <div className="text-center">
                    <div className="w-10 h-10 rounded-full mx-auto mb-2 flex items-center justify-center" style={{ backgroundColor: formData.primaryColor + '15' }}>
                      <AlertCircle className="h-5 w-5" style={{ color: formData.primaryColor }} />
                    </div>
                    <h4 className="font-semibold text-sm" style={{ color: formData.textColor }}>{t('widgetsPage.preview.termsTitle', 'Terms & Conditions')}</h4>
                    <p className="text-xs mt-1 opacity-60" style={{ color: formData.textColor }}>
                      {t('widgetsPage.preview.termsDesc', 'Please accept before continuing')}
                    </p>
                  </div>
                  <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg transition-colors hover:bg-black/5">
                    <input
                      type="checkbox"
                      checked={termsAccepted}
                      onChange={(e) => setTermsAccepted(e.target.checked)}
                      data-testid="checkbox-preview-terms"
                      className="mt-0.5 h-4 w-4 rounded"
                      style={{ accentColor: formData.primaryColor }}
                    />
                    <span className="text-xs leading-relaxed" style={{ color: formData.textColor }}>
                      {t('widgetsPage.preview.termsAgree', 'I agree to the Terms & Conditions and Privacy Policy')}
                    </span>
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setCallState('idle')}
                      data-testid="button-preview-terms-cancel"
                      className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium border transition-colors hover:bg-black/5"
                      style={{ borderColor: formData.textColor + '20', color: formData.textColor }}
                    >
                      {t('common.cancel', 'Cancel')}
                    </button>
                    <button
                      onClick={handleAcceptTerms}
                      disabled={!termsAccepted}
                      data-testid="button-preview-terms-accept"
                      className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-white transition-all disabled:opacity-40"
                      style={{ backgroundColor: formData.primaryColor }}
                    >
                      {t('widgetsPage.preview.continue', 'Continue')}
                    </button>
                  </div>
                </div>
              ) : callState === 'active' || callState === 'connecting' || callState === 'ended' ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="relative flex-shrink-0">
                      <div 
                        className={`w-12 h-12 rounded-full flex items-center justify-center overflow-hidden ${callState === 'active' ? 'ring-2 ring-offset-2' : ''}`}
                        style={{ 
                          backgroundColor: formData.primaryColor + '15',
                          ['--tw-ring-color' as string]: formData.primaryColor,
                          ['--tw-ring-offset-color' as string]: formData.backgroundColor
                        }}
                      >
                        {formData.iconPreview ? (
                          <img src={formData.iconPreview} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <Phone className="h-5 w-5" style={{ color: formData.primaryColor }} />
                        )}
                      </div>
                      <div className="absolute -bottom-0.5 -right-0.5 text-white text-[8px] px-1.5 py-0.5 rounded-full font-bold shadow-sm" style={{ backgroundColor: formData.primaryColor }}>
                        AI
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate" style={{ color: formData.textColor }}>
                        {formData.brandName || formData.name || "AI Assistant"}
                      </div>
                      <div className="text-xl font-bold tabular-nums" style={{ color: formData.textColor }}>
                        {callState === 'connecting' ? (
                          <span className="flex items-center gap-2">
                            <span className="inline-flex gap-0.5">
                              <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ backgroundColor: formData.primaryColor, animationDelay: '0ms' }} />
                              <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ backgroundColor: formData.primaryColor, animationDelay: '150ms' }} />
                              <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ backgroundColor: formData.primaryColor, animationDelay: '300ms' }} />
                            </span>
                            <span className="text-sm font-normal opacity-70">{t('widgetsPage.preview.connecting', 'Connecting')}</span>
                          </span>
                        ) : callState === 'ended' ? (
                          <span className="flex items-center gap-2 text-green-600">
                            <Check className="h-5 w-5" />
                            <span className="text-sm font-normal">{t('widgetsPage.preview.callEnded', 'Call ended')}</span>
                          </span>
                        ) : formatTime(timer)}
                      </div>
                    </div>
                  </div>

                  {callState === 'active' && (
                    <div className="flex items-center justify-center gap-1 h-8 px-4">
                      {[1,2,3,4,5,6,7].map((i) => (
                        <div 
                          key={i} 
                          className="w-1 rounded-full transition-all"
                          style={{ 
                            backgroundColor: formData.primaryColor,
                            opacity: 0.6,
                            height: `${8 + Math.sin(Date.now() / 200 + i) * 12}px`,
                            animation: `pulse 0.8s ease-in-out infinite`,
                            animationDelay: `${i * 0.1}s`
                          }}
                        />
                      ))}
                    </div>
                  )}

                  {callState === 'connecting' && (
                    <div className="flex justify-center py-2">
                      <div className="w-12 h-12 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: formData.primaryColor, borderTopColor: 'transparent' }} />
                    </div>
                  )}

                  {callState === 'active' && (
                    <div className="flex justify-center gap-4 pt-2">
                      <button
                        onClick={() => setIsMuted(!isMuted)}
                        data-testid="button-preview-mute"
                        className={`w-12 h-12 rounded-full flex items-center justify-center transition-all shadow-sm ${
                          isMuted ? 'bg-red-500 text-white scale-105' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                      </button>
                      <button
                        onClick={handleEndCall}
                        data-testid="button-preview-end"
                        className="w-12 h-12 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-all shadow-sm hover:scale-105 active:scale-95"
                      >
                        <PhoneOff className="h-5 w-5" />
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="relative flex-shrink-0">
                    <div 
                      className="w-14 h-14 rounded-full flex items-center justify-center overflow-hidden transition-transform hover:scale-105"
                      style={{ 
                        backgroundColor: formData.primaryColor + '12',
                        border: `2px solid ${formData.primaryColor}25`
                      }}
                    >
                      {formData.iconPreview ? (
                        <img src={formData.iconPreview} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <Phone className="h-6 w-6" style={{ color: formData.primaryColor }} />
                      )}
                    </div>
                    <div 
                      className="absolute -bottom-0.5 -right-0.5 text-white text-[8px] px-1.5 py-0.5 rounded-full font-bold shadow-sm"
                      style={{ backgroundColor: formData.primaryColor }}
                    >
                      AI
                    </div>
                    <div 
                      className="text-[10px] text-center mt-1.5 font-medium truncate max-w-[56px] leading-tight"
                      style={{ color: formData.textColor }}
                    >
                      {formData.brandName || formData.name || "Agent"}
                    </div>
                  </div>
                  
                  <button
                    onClick={handleCallClick}
                    data-testid="button-preview-call"
                    className="flex items-center gap-2.5 px-5 py-3 rounded-full text-white font-semibold transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg hover:shadow-xl"
                    style={{ 
                      background: 'linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%)',
                    }}
                  >
                    <Phone className="h-4 w-4" />
                    <span className="text-sm tracking-wide">{formData.buttonLabel || t('widgetsPage.preview.voiceChat', 'VOICE CHAT')}</span>
                  </button>
                  
                  <div 
                    data-testid="button-preview-language"
                    className="flex items-center gap-1.5 px-3 py-2 rounded-full border cursor-pointer transition-colors hover:bg-black/5"
                    style={{ borderColor: formData.textColor + '15' }}
                  >
                    <span className="text-base">&#127482;&#127480;</span>
                    <ChevronDown className="h-3.5 w-3.5 opacity-50" style={{ color: formData.textColor }} />
                  </div>
                </div>
              )}
            </div>
            
            <div className="text-center mt-2.5 text-[11px] text-foreground/40">
              {t('widgetsPage.preview.poweredBy', 'Powered by')} <span className="font-medium" style={{ color: formData.primaryColor }}>{appName}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="absolute top-11 left-3 z-10">
        <div className="flex items-center gap-2 bg-background/90 backdrop-blur-sm rounded-lg px-3 py-1.5 shadow-sm border border-border/50">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-[10px] font-medium text-foreground/70">{t('widgetsPage.preview.interactiveDemo', 'Interactive Demo')}</span>
          </div>
          {callState !== 'idle' && (
            <>
              <div className="w-px h-3 bg-border" />
              <button 
                onClick={resetPreview} 
                data-testid="button-preview-reset"
                className="text-[10px] font-medium text-primary hover:underline"
              >
                {t('widgetsPage.preview.reset', 'Reset')}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-background/80 to-transparent p-3 pt-6">
        <p className="text-center text-[10px] text-muted-foreground">
          {t('widgetsPage.preview.clickToPreview', 'Click the widget button to preview the call experience')}
        </p>
      </div>
    </div>
  );
}
