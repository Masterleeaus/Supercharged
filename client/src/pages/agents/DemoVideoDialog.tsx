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
import { Play } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Dispatch, SetStateAction } from "react";

export interface DemoVideoDialogProps {
  isVideoOpen: boolean;
  setIsVideoOpen: Dispatch<SetStateAction<boolean>>;
}

export function DemoVideoDialog({ isVideoOpen, setIsVideoOpen }: DemoVideoDialogProps) {
  return (
    <Dialog open={isVideoOpen} onOpenChange={setIsVideoOpen}>
              <DialogContent className="sm:max-w-[850px] p-2 bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
                <DialogHeader className="p-4 pb-2 text-left">
                  <DialogTitle className="text-lg font-bold text-white flex items-center gap-2">
                    <Play className="h-5 w-5 text-blue-400 fill-blue-400" />
                    AI Agents Demonstration Video
                  </DialogTitle>
                  <DialogDescription className="text-xs text-slate-400">
                    Watch a walkthrough on creating and configuring AI voice agents.
                  </DialogDescription>
                </DialogHeader>
                <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-black border border-slate-800">
                  {isVideoOpen && (
                    <iframe
                      src="https://drive.google.com/file/d/1aZZMTubUwnuSrwzC0xlfHGXLlDAaPg3c/preview"
                      className="w-full h-full border-0"
                      allow="autoplay; encrypted-media; picture-in-picture"
                      allowFullScreen
                      title="AI Agents Demo Video"
                    />
                  )}
                </div>
                <div className="p-3 pt-2 text-right">
                  <a
                    href="https://drive.google.com/file/d/1aZZMTubUwnuSrwzC0xlfHGXLlDAaPg3c/view?usp=drive_link"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:underline inline-flex items-center gap-1 font-medium"
                  >
                    Open in Google Drive &rarr;
                  </a>
                </div>
              </DialogContent>
            </Dialog>
  );
}
