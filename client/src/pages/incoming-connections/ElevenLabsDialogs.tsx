/* Dialogs for the Twilio + ElevenLabs engine tab. */
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { SiTwilio } from "react-icons/si";
import { useTranslation } from "react-i18next";
import { ElevenLabsIcon } from "./ElevenLabsIcon";
import type { Agent, PhoneNumber, IncomingConnection, ConnectionMutation } from "./types";

export interface ElevenLabsDialogsProps {
  createDialogOpen: boolean;
  setCreateDialogOpen: (open: boolean) => void;
  selectedAgentId: string;
  setSelectedAgentId: (id: string) => void;
  selectedPhoneId: string;
  setSelectedPhoneId: (id: string) => void;
  agents: Agent[];
  availablePhoneNumbers: PhoneNumber[];
  isFreePlan: boolean;
  setLocation: (to: string) => void;
  handleCreate: () => void;
  createMutation: ConnectionMutation<{ agentId: string; phoneNumberId: string }>;
  deleteConnection: IncomingConnection | null;
  setDeleteConnection: (connection: IncomingConnection | null) => void;
  deleteMutation: ConnectionMutation<string>;
}

export function ElevenLabsDialogs(props: ElevenLabsDialogsProps) {
  const { t } = useTranslation();
  const { createDialogOpen, setCreateDialogOpen, selectedAgentId, setSelectedAgentId, selectedPhoneId, setSelectedPhoneId, agents, availablePhoneNumbers, isFreePlan, setLocation, handleCreate, createMutation, deleteConnection, setDeleteConnection, deleteMutation } = props;
  return (
    <>
      {/* Twilio + ElevenLabs Create Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent data-testid="dialog-create-connection">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SiTwilio className="h-5 w-5 text-red-500" />
              <ElevenLabsIcon className="h-5 w-5 text-violet-600" />
              {t("incomingConnections.dialog.createTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("incomingConnections.dialog.createDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="agent">
                {t("incomingConnections.form.agentLabel")} <span className="text-destructive">*</span>
              </Label>
              <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                <SelectTrigger id="agent" data-testid="select-agent">
                  <SelectValue placeholder={t("incomingConnections.form.agentPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {agents.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">
                      {t("incomingConnections.form.noAgents")}
                    </div>
                  ) : (
                    agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">
                {t("incomingConnections.form.phoneLabel")} <span className="text-destructive">*</span>
              </Label>
              <Select value={selectedPhoneId} onValueChange={setSelectedPhoneId}>
                <SelectTrigger id="phone" data-testid="select-phone">
                  <SelectValue placeholder={t("incomingConnections.form.phonePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {availablePhoneNumbers.length === 0 ? (
                    isFreePlan ? (
                      <div className="p-3 space-y-2">
                        <p className="text-sm text-muted-foreground">
                          {t("incomingConnections.form.freePlanNoPhones")}
                        </p>
                        <Button
                          size="sm"
                          className="w-full"
                          onClick={() => setLocation("/app/billing?tab=plans")}
                          data-testid="button-upgrade-for-phone"
                        >
                          {t("incomingConnections.form.upgradeNow")}
                        </Button>
                      </div>
                    ) : (
                      <div className="p-2 text-sm text-muted-foreground">
                        {t("incomingConnections.form.noPhones")}
                      </div>
                    )
                  ) : (
                    availablePhoneNumbers.map((phone) => (
                      phone.isConflicted ? (
                        <TooltipProvider key={phone.id}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="relative flex w-full cursor-not-allowed select-none items-center rounded-sm py-1.5 px-2 text-sm outline-none opacity-50">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono">{phone.phoneNumber}</span>
                                  <span className="text-xs text-destructive font-medium">(In Use)</span>
                                </div>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-xs">
                              <p>{phone.conflictReason || "This phone is being used by an active campaign"}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <SelectItem key={phone.id} value={phone.id}>
                          <div className="flex items-center gap-2">
                            <span className="font-mono">{phone.phoneNumber}</span>
                            {phone.friendlyName && (
                              <span className="text-muted-foreground">({phone.friendlyName})</span>
                            )}
                          </div>
                        </SelectItem>
                      )
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreateDialogOpen(false); setSelectedAgentId(""); setSelectedPhoneId(""); }}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createMutation.isPending || !selectedAgentId || !selectedPhoneId}
              className="bg-violet-600 hover:bg-violet-700"
            >
              {createMutation.isPending ? t("incomingConnections.actions.creating") : t("incomingConnections.actions.createConnection")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Twilio + ElevenLabs Delete Dialog */}
      <AlertDialog open={!!deleteConnection} onOpenChange={() => setDeleteConnection(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("incomingConnections.dialog.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("incomingConnections.dialog.deleteDescription")}{" "}
              <span className="font-mono font-semibold">{deleteConnection?.phoneNumber.phoneNumber}</span>{" "}
              {t("incomingConnections.dialog.deleteDescriptionRoute")}{" "}
              <span className="font-semibold">{deleteConnection?.agent.name}</span>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteConnection && deleteMutation.mutate(deleteConnection.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? t("incomingConnections.actions.deleting") : t("incomingConnections.actions.deleteConnection")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </>
  );
}
