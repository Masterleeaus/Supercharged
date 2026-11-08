import { useState } from "react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Phone, Sparkles } from "lucide-react";
import { CveTestCallWidget } from "./CveTestCallWidget";
import { useDemoMode } from "@/components/DemoModeBanner";

interface CveTestCallDialogProps {
  buttonClassName?: string;
  buttonVariant?: "default" | "outline" | "ghost" | "secondary" | "destructive";
  buttonText?: string;
  iconClassName?: string;
  isPromoStyle?: boolean;
}

export function CveTestCallDialog({
  buttonClassName = "",
  buttonVariant = "default",
  buttonText = "Test Live Call",
  iconClassName = "h-4 w-4 mr-2",
  isPromoStyle = true
}: CveTestCallDialogProps) {
  const [open, setOpen] = useState(false);
  const { isDemoMode } = useDemoMode();

  if (!isDemoMode) {
    return null;
  }

  // If isPromoStyle is active, we apply a gorgeous glowing gradient style with a pulsing live indicator
  const finalClassName = isPromoStyle
    ? `relative overflow-hidden bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 text-white hover:opacity-95 hover:scale-105 active:scale-95 shadow-lg shadow-emerald-500/20 font-semibold rounded-full px-6 transition-all duration-300 group ${buttonClassName}`
    : buttonClassName;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button 
          variant={isPromoStyle ? "default" : buttonVariant} 
          className={finalClassName} 
          data-testid="btn-test-call-trigger"
        >
          {/* Glowing background shine effect on hover */}
          {isPromoStyle && (
            <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-out" />
          )}
          
          <Phone className={`${iconClassName} ${isPromoStyle ? 'animate-pulse group-hover:rotate-12 transition-transform duration-300' : ''}`} />
          <span>{buttonText}</span>

          {/* Live pulsing green dot */}
          {isPromoStyle && (
            <span className="relative flex h-2 w-2 ml-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
            </span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px] p-0 overflow-hidden bg-transparent border-none shadow-2xl">
        <CveTestCallWidget />
      </DialogContent>
    </Dialog>
  );
}
