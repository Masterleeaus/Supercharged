/* Dialogs for the Plivo + OpenAI engine tab. */
import { Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { SiOpenai } from "react-icons/si";

import type { Agent, PlivoAgent, PlivoConnection, PlivoAvailableNumber, ConnectionMutation } from "./types";

export interface PlivoDialogsProps {
  plivoCreateDialogOpen: boolean;
  setPlivoCreateDialogOpen: (open: boolean) => void;
  selectedPlivoAgentId: string;
  setSelectedPlivoAgentId: (id: string) => void;
  selectedPlivoPhoneId: string;
  setSelectedPlivoPhoneId: (id: string) => void;
  plivoAvailableAgents: PlivoAgent[];
  plivoAvailablePhoneNumbers: PlivoAvailableNumber[];
  handlePlivoCreate: () => void;
  plivoCreateMutation: ConnectionMutation<{ agentId: string; phoneNumberId: string }>;
  plivoDeleteConnection: PlivoConnection | null;
  setPlivoDeleteConnection: (connection: PlivoConnection | null) => void;
  plivoDeleteMutation: ConnectionMutation<string>;
}

export function PlivoDialogs(props: PlivoDialogsProps) {
  const { plivoCreateDialogOpen, setPlivoCreateDialogOpen, selectedPlivoAgentId, setSelectedPlivoAgentId, selectedPlivoPhoneId, setSelectedPlivoPhoneId, plivoAvailableAgents, plivoAvailablePhoneNumbers, handlePlivoCreate, plivoCreateMutation, plivoDeleteConnection, setPlivoDeleteConnection, plivoDeleteMutation } = props;
  return (
    <>
      {/* Plivo Create Connection Dialog */}
      <Dialog open={plivoCreateDialogOpen} onOpenChange={setPlivoCreateDialogOpen}>
        <DialogContent data-testid="dialog-create-plivo-connection">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Phone className="h-5 w-5 text-green-600" />
              <SiOpenai className="h-5 w-5 text-emerald-600" />
              Create Plivo + OpenAI Connection
            </DialogTitle>
            <DialogDescription>
              Connect a Plivo phone number to an OpenAI-powered agent for incoming calls.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="plivo-agent">OpenAI Agent <span className="text-destructive">*</span></Label>
              <Select value={selectedPlivoAgentId} onValueChange={setSelectedPlivoAgentId}>
                <SelectTrigger id="plivo-agent" data-testid="select-plivo-agent">
                  <SelectValue placeholder="Select an OpenAI agent" />
                </SelectTrigger>
                <SelectContent>
                  {plivoAvailableAgents.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">No OpenAI agents available.</div>
                  ) : (
                    plivoAvailableAgents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        <div className="flex items-center gap-2">
                          <SiOpenai className="h-3 w-3 text-emerald-600" />
                          <span>{agent.name}</span>
                        </div>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="plivo-phone">Plivo Phone Number <span className="text-destructive">*</span></Label>
              <Select value={selectedPlivoPhoneId} onValueChange={setSelectedPlivoPhoneId}>
                <SelectTrigger id="plivo-phone" data-testid="select-plivo-phone">
                  <SelectValue placeholder="Select a Plivo phone number" />
                </SelectTrigger>
                <SelectContent>
                  {plivoAvailablePhoneNumbers.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">No available Plivo phone numbers.</div>
                  ) : (
                    plivoAvailablePhoneNumbers.map((phone) => (
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
                          <span className="text-xs text-muted-foreground ml-2">({phone.country})</span>
                        </SelectItem>
                      )
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setPlivoCreateDialogOpen(false); setSelectedPlivoAgentId(""); setSelectedPlivoPhoneId(""); }}>
              Cancel
            </Button>
            <Button
              onClick={handlePlivoCreate}
              disabled={plivoCreateMutation.isPending || !selectedPlivoAgentId || !selectedPlivoPhoneId}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {plivoCreateMutation.isPending ? "Creating..." : "Create Connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Plivo Delete Dialog */}
      <AlertDialog open={!!plivoDeleteConnection} onOpenChange={() => setPlivoDeleteConnection(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Connection</AlertDialogTitle>
            <AlertDialogDescription>
              This will disconnect <span className="font-mono font-semibold">{plivoDeleteConnection?.phoneNumber}</span>{" "}
              from <span className="font-semibold">{plivoDeleteConnection?.agent?.name}</span>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => plivoDeleteConnection && plivoDeleteMutation.mutate(plivoDeleteConnection.phoneNumberId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {plivoDeleteMutation.isPending ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </>
  );
}
