
/**
 * Admin Voice Engine Settings
 * Manages API keys, active providers, FreeSWITCH nodes, and SIP trunking templates.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";
import { SipGateway } from "@/components/admin/voice-engine-settings/shared";

export interface SipGatewayDialogProps {
  isGatewayDialogOpen: boolean;
  setIsGatewayDialogOpen: Dispatch<SetStateAction<boolean>>;
  editingGateway: SipGateway;
  gwName: string;
  setGwName: Dispatch<SetStateAction<string>>;
  gwUsername: string;
  setGwUsername: Dispatch<SetStateAction<string>>;
  gwPassword: string;
  setGwPassword: Dispatch<SetStateAction<string>>;
  gwProxy: string;
  setGwProxy: Dispatch<SetStateAction<string>>;
  gwRegister: boolean;
  setGwRegister: Dispatch<SetStateAction<boolean>>;
  gwCallerIdInFrom: boolean;
  setGwCallerIdInFrom: Dispatch<SetStateAction<boolean>>;
  handleSaveGateway: () => void;
  saveGatewayMutation: UseMutationResult<any, any, any, unknown>;
  isDemoMode: boolean;
}

export function SipGatewayDialog({ isGatewayDialogOpen, setIsGatewayDialogOpen, editingGateway, gwName, setGwName, gwUsername, setGwUsername, gwPassword, setGwPassword, gwProxy, setGwProxy, gwRegister, setGwRegister, gwCallerIdInFrom, setGwCallerIdInFrom, handleSaveGateway, saveGatewayMutation, isDemoMode }: SipGatewayDialogProps) {
  return (
    <Dialog open={isGatewayDialogOpen} onOpenChange={setIsGatewayDialogOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{editingGateway ? "Edit SIP Gateway" : "Add SIP Gateway"}</DialogTitle>
            <DialogDescription>Provide details for your SIP trunk credentials and domain settings.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
              <Label htmlFor="gwName" className="sm:text-right pt-1.5 sm:pt-0">Gateway Name</Label>
              <Input id="gwName" value={gwName} onChange={(e) => setGwName(e.target.value)} placeholder="e.g. plivo or twilio" className="sm:col-span-3" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
              <Label htmlFor="gwUsername" className="sm:text-right pt-1.5 sm:pt-0">SIP Username</Label>
              <Input id="gwUsername" value={gwUsername} onChange={(e) => setGwUsername(e.target.value)} placeholder="Username or Account SID" className="sm:col-span-3" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
              <Label htmlFor="gwPassword" className="sm:text-right pt-1.5 sm:pt-0">SIP Password</Label>
              <Input id="gwPassword" type="password" value={gwPassword} onChange={(e) => setGwPassword(e.target.value)} placeholder="Password or Token" className="sm:col-span-3" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
              <Label htmlFor="gwProxy" className="sm:text-right pt-1.5 sm:pt-0">Proxy Address</Label>
              <Input id="gwProxy" value={gwProxy} onChange={(e) => setGwProxy(e.target.value)} placeholder="e.g. phone.plivo.com" className="sm:col-span-3" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
              <Label htmlFor="gwRegister" className="sm:text-right pt-1.5 sm:pt-0">Register</Label>
              <div className="flex items-center space-x-2 sm:col-span-3">
                <input
                  type="checkbox"
                  id="gwRegister"
                  checked={gwRegister}
                  onChange={(e) => setGwRegister(e.target.checked)}
                  className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                />
                <span className="text-xs text-muted-foreground">Enable SIP registration (false for Plivo/Twilio termination)</span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
              <Label htmlFor="gwCallerIdInFrom" className="sm:text-right pt-1.5 sm:pt-0">Caller-ID in From</Label>
              <div className="flex items-center space-x-2 sm:col-span-3">
                <input
                  type="checkbox"
                  id="gwCallerIdInFrom"
                  checked={gwCallerIdInFrom}
                  onChange={(e) => setGwCallerIdInFrom(e.target.checked)}
                  className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                />
                <span className="text-xs text-muted-foreground">Send caller-ID in the SIP FROM header</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsGatewayDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveGateway} disabled={saveGatewayMutation.isPending || isDemoMode} title={isDemoMode ? "Not available in demo mode" : undefined}>
              {saveGatewayMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Gateway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );
}
