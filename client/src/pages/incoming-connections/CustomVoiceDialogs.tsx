/* Dialogs for the Custom Voice engine tab. */
import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

import type { Agent, PhoneNumber, IncomingConnection, ConnectionMutation } from "./types";

export interface CustomVoiceDialogsProps {
  cveCreateDialogOpen: boolean;
  setCveCreateDialogOpen: (open: boolean) => void;
  selectedCveAgentId: string;
  setSelectedCveAgentId: (id: string) => void;
  selectedCvePhoneId: string;
  setSelectedCvePhoneId: (id: string) => void;
  cveAgents: Agent[];
  allAvailableNumbersForCve: Array<PhoneNumber & { provider: string }>;
  handleCveCreate: () => void;
  cveCreateMutation: ConnectionMutation<{ agentId: string; phoneNumberId: string }>;
  cveDeleteConnection: IncomingConnection | null;
  setCveDeleteConnection: (connection: IncomingConnection | null) => void;
  cveDeleteMutation: ConnectionMutation<string>;
}

export function CustomVoiceDialogs(props: CustomVoiceDialogsProps) {
  const { cveCreateDialogOpen, setCveCreateDialogOpen, selectedCveAgentId, setSelectedCveAgentId, selectedCvePhoneId, setSelectedCvePhoneId, cveAgents, allAvailableNumbersForCve, handleCveCreate, cveCreateMutation, cveDeleteConnection, setCveDeleteConnection, cveDeleteMutation } = props;
  return (
    <>
      {/* Custom Voice Create Dialog */}
      <Dialog open={cveCreateDialogOpen} onOpenChange={setCveCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mic className="h-5 w-5 text-indigo-600" />
              Create Custom Voice Connection
            </DialogTitle>
            <DialogDescription>
              Connect any available phone number to a Custom Voice Engine agent.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="cve-agent">Custom Voice Agent <span className="text-destructive">*</span></Label>
              <Select value={selectedCveAgentId} onValueChange={setSelectedCveAgentId}>
                <SelectTrigger id="cve-agent">
                  <SelectValue placeholder="Select a Custom Voice agent" />
                </SelectTrigger>
                <SelectContent>
                  {cveAgents.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">No Custom Voice agents available.</div>
                  ) : (
                    cveAgents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="cve-phone">Phone Number <span className="text-destructive">*</span></Label>
              <Select value={selectedCvePhoneId} onValueChange={setSelectedCvePhoneId}>
                <SelectTrigger id="cve-phone">
                  <SelectValue placeholder="Select a phone number" />
                </SelectTrigger>
                <SelectContent>
                  {allAvailableNumbersForCve.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">No available phone numbers.</div>
                  ) : (
                    allAvailableNumbersForCve.map((phone) => (
                      phone.isConflicted ? (
                        <TooltipProvider key={phone.id}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="relative flex w-full cursor-not-allowed select-none items-center rounded-sm py-1.5 px-2 text-sm outline-none opacity-50">
                                <span className="font-mono">{phone.phoneNumber}</span>
                                <span className="text-xs text-destructive font-medium ml-2">(In Use)</span>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent><p>{phone.conflictReason}</p></TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <SelectItem key={phone.id} value={phone.id}>
                          <span className="font-mono">{phone.phoneNumber}</span>
                          <span className="text-xs text-muted-foreground ml-2">({(phone as any).provider === 'plivo' ? 'Plivo' : 'Twilio'})</span>
                          {phone.friendlyName && (
                            <span className="text-xs text-muted-foreground ml-2">({phone.friendlyName})</span>
                          )}
                        </SelectItem>
                      )
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setCveCreateDialogOpen(false); setSelectedCveAgentId(""); setSelectedCvePhoneId(""); }}>
              Cancel
            </Button>
            <Button
              onClick={handleCveCreate}
              disabled={cveCreateMutation.isPending || !selectedCveAgentId || !selectedCvePhoneId}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {cveCreateMutation.isPending ? "Creating..." : "Create Connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Custom Voice Delete Dialog */}
      <AlertDialog open={!!cveDeleteConnection} onOpenChange={() => setCveDeleteConnection(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Connection</AlertDialogTitle>
            <AlertDialogDescription>
              This will disconnect <span className="font-mono font-semibold">{cveDeleteConnection?.phoneNumber.phoneNumber}</span>{" "}
              from <span className="font-semibold">{cveDeleteConnection?.agent.name}</span>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => cveDeleteConnection && cveDeleteMutation.mutate(cveDeleteConnection.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cveDeleteMutation.isPending ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
