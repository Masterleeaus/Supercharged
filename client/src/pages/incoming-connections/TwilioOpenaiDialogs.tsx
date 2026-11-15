/* Dialogs for the Twilio + OpenAI engine tab. */
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { SiOpenai, SiTwilio } from "react-icons/si";

import type { Agent, TwilioOpenaiAgent, TwilioOpenaiConnection, TwilioOpenaiAvailableNumber, ConnectionMutation } from "./types";

export interface TwilioOpenaiDialogsProps {
  twilioOpenaiCreateDialogOpen: boolean;
  setTwilioOpenaiCreateDialogOpen: (open: boolean) => void;
  selectedTwilioOpenaiAgentId: string;
  setSelectedTwilioOpenaiAgentId: (id: string) => void;
  selectedTwilioOpenaiPhoneId: string;
  setSelectedTwilioOpenaiPhoneId: (id: string) => void;
  twilioOpenaiAvailableAgents: TwilioOpenaiAgent[];
  twilioOpenaiAvailablePhoneNumbers: TwilioOpenaiAvailableNumber[];
  handleTwilioOpenaiCreate: () => void;
  twilioOpenaiCreateMutation: ConnectionMutation<{ agentId: string; phoneNumberId: string }>;
  twilioOpenaiDeleteConnection: TwilioOpenaiConnection | null;
  setTwilioOpenaiDeleteConnection: (connection: TwilioOpenaiConnection | null) => void;
  twilioOpenaiDeleteMutation: ConnectionMutation<string>;
}

export function TwilioOpenaiDialogs(props: TwilioOpenaiDialogsProps) {
  const { twilioOpenaiCreateDialogOpen, setTwilioOpenaiCreateDialogOpen, selectedTwilioOpenaiAgentId, setSelectedTwilioOpenaiAgentId, selectedTwilioOpenaiPhoneId, setSelectedTwilioOpenaiPhoneId, twilioOpenaiAvailableAgents, twilioOpenaiAvailablePhoneNumbers, handleTwilioOpenaiCreate, twilioOpenaiCreateMutation, twilioOpenaiDeleteConnection, setTwilioOpenaiDeleteConnection, twilioOpenaiDeleteMutation } = props;
  return (
    <>
      {/* Twilio + OpenAI Create Dialog */}
      <Dialog open={twilioOpenaiCreateDialogOpen} onOpenChange={setTwilioOpenaiCreateDialogOpen}>
        <DialogContent data-testid="dialog-create-twilio-openai-connection">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SiTwilio className="h-5 w-5 text-red-500" />
              <SiOpenai className="h-5 w-5 text-brand" />
              Create Twilio + OpenAI Connection
            </DialogTitle>
            <DialogDescription>
              Connect a Twilio phone number to an OpenAI-powered agent for incoming calls.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="twilio-openai-agent">OpenAI Agent <span className="text-destructive">*</span></Label>
              <Select value={selectedTwilioOpenaiAgentId} onValueChange={setSelectedTwilioOpenaiAgentId}>
                <SelectTrigger id="twilio-openai-agent" data-testid="select-twilio-openai-agent">
                  <SelectValue placeholder="Select an OpenAI agent" />
                </SelectTrigger>
                <SelectContent>
                  {twilioOpenaiAvailableAgents.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">No OpenAI agents available.</div>
                  ) : (
                    twilioOpenaiAvailableAgents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        <div className="flex items-center gap-2">
                          <SiOpenai className="h-3 w-3 text-brand" />
                          <span>{agent.name}</span>
                        </div>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="twilio-openai-phone">Twilio Phone Number <span className="text-destructive">*</span></Label>
              <Select value={selectedTwilioOpenaiPhoneId} onValueChange={setSelectedTwilioOpenaiPhoneId}>
                <SelectTrigger id="twilio-openai-phone" data-testid="select-twilio-openai-phone">
                  <SelectValue placeholder="Select a Twilio phone number" />
                </SelectTrigger>
                <SelectContent>
                  {twilioOpenaiAvailablePhoneNumbers.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">No available Twilio phone numbers.</div>
                  ) : (
                    twilioOpenaiAvailablePhoneNumbers.map((phone) => (
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
            <Button variant="outline" onClick={() => { setTwilioOpenaiCreateDialogOpen(false); setSelectedTwilioOpenaiAgentId(""); setSelectedTwilioOpenaiPhoneId(""); }}>
              Cancel
            </Button>
            <Button
              onClick={handleTwilioOpenaiCreate}
              disabled={twilioOpenaiCreateMutation.isPending || !selectedTwilioOpenaiAgentId || !selectedTwilioOpenaiPhoneId}
              className="bg-brand text-brand-foreground"
            >
              {twilioOpenaiCreateMutation.isPending ? "Creating..." : "Create Connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Twilio + OpenAI Delete Dialog */}
      <AlertDialog open={!!twilioOpenaiDeleteConnection} onOpenChange={() => setTwilioOpenaiDeleteConnection(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Connection</AlertDialogTitle>
            <AlertDialogDescription>
              This will disconnect <span className="font-mono font-semibold">{twilioOpenaiDeleteConnection?.phoneNumber?.phoneNumber}</span>{" "}
              from <span className="font-semibold">{twilioOpenaiDeleteConnection?.agent?.name}</span>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => twilioOpenaiDeleteConnection && twilioOpenaiDeleteMutation.mutate(twilioOpenaiDeleteConnection.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {twilioOpenaiDeleteMutation.isPending ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </>
  );
}
