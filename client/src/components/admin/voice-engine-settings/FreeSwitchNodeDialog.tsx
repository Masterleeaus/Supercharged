
/**
 * Admin Voice Engine Settings
 * Manages API keys, active providers, FreeSWITCH nodes, and SIP trunking templates.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";
import { FreeSwitchNode } from "@/components/admin/voice-engine-settings/shared";

export interface FreeSwitchNodeDialogProps {
  isNodeDialogOpen: boolean;
  setIsNodeDialogOpen: Dispatch<SetStateAction<boolean>>;
  editingNode: FreeSwitchNode;
  nodeName: string;
  setNodeName: Dispatch<SetStateAction<string>>;
  eslHost: string;
  setEslHost: Dispatch<SetStateAction<string>>;
  eslPort: string;
  setEslPort: Dispatch<SetStateAction<string>>;
  eslPassword: string;
  setEslPassword: Dispatch<SetStateAction<string>>;
  sipHost: string;
  setSipHost: Dispatch<SetStateAction<string>>;
  sipPort: string;
  setSipPort: Dispatch<SetStateAction<string>>;
  wsPort: string;
  setWsPort: Dispatch<SetStateAction<string>>;
  maxCalls: string;
  setMaxCalls: Dispatch<SetStateAction<string>>;
  nodeStatus: "online" | "offline" | "degraded" | "maintenance";
  setNodeStatus: Dispatch<SetStateAction<"online" | "offline" | "degraded" | "maintenance">>;
  handleSaveNode: () => void;
  saveNodeMutation: UseMutationResult<any, any, any, unknown>;
  isDemoMode: boolean;
}

export function FreeSwitchNodeDialog({ isNodeDialogOpen, setIsNodeDialogOpen, editingNode, nodeName, setNodeName, eslHost, setEslHost, eslPort, setEslPort, eslPassword, setEslPassword, sipHost, setSipHost, sipPort, setSipPort, wsPort, setWsPort, maxCalls, setMaxCalls, nodeStatus, setNodeStatus, handleSaveNode, saveNodeMutation, isDemoMode }: FreeSwitchNodeDialogProps) {
  return (
    <Dialog open={isNodeDialogOpen} onOpenChange={setIsNodeDialogOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{editingNode ? "Edit FreeSWITCH Node" : "Add FreeSWITCH Node"}</DialogTitle>
            <DialogDescription>Provide configuration settings for your FreeSWITCH ESL and SIP endpoints.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            {[
              { id: "name", label: "Name", value: nodeName, onChange: setNodeName, placeholder: "e.g. US-East-Primary" },
            ].map(({ id, label, value, onChange, placeholder }) => (
              <div key={id} className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
                <Label htmlFor={id} className="sm:text-right pt-1.5 sm:pt-0">{label}</Label>
                <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="sm:col-span-3" />
              </div>
            ))}

            <div className="border-t my-1 pt-3">
              <h4 className="text-sm font-semibold mb-1 text-indigo-600 dark:text-indigo-400">Event Socket Library (ESL)</h4>
            </div>

            {[
              { id: "eslHost", label: "ESL Host", value: eslHost, onChange: setEslHost, placeholder: "127.0.0.1" },
              { id: "eslPort", label: "ESL Port", value: eslPort, onChange: setEslPort, placeholder: "8021" },
            ].map(({ id, label, value, onChange, placeholder }) => (
              <div key={id} className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
                <Label htmlFor={id} className="sm:text-right pt-1.5 sm:pt-0">{label}</Label>
                <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="sm:col-span-3" />
              </div>
            ))}

            <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
              <Label htmlFor="eslPassword" className="sm:text-right pt-1.5 sm:pt-0">ESL Pass</Label>
              <Input id="eslPassword" type="password" value={eslPassword} onChange={(e) => setEslPassword(e.target.value)} placeholder="ClueCon" className="sm:col-span-3" />
            </div>

            <div className="border-t my-1 pt-3">
              <h4 className="text-sm font-semibold mb-1 text-indigo-600 dark:text-indigo-400">SIP &amp; WebSocket Endpoints</h4>
            </div>

            {[
              { id: "sipHost", label: "SIP Host", value: sipHost, onChange: setSipHost, placeholder: "e.g. 52.4.123.8" },
              { id: "sipPort", label: "SIP Port", value: sipPort, onChange: setSipPort, placeholder: "5060" },
              { id: "wsPort", label: "WS Port", value: wsPort, onChange: setWsPort, placeholder: "8089" },
              { id: "maxCalls", label: "Max Calls", value: maxCalls, onChange: setMaxCalls, placeholder: "100" },
            ].map(({ id, label, value, onChange, placeholder }) => (
              <div key={id} className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
                <Label htmlFor={id} className="sm:text-right pt-1.5 sm:pt-0">{label}</Label>
                <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="sm:col-span-3" />
              </div>
            ))}

            <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
              <Label htmlFor="status" className="sm:text-right pt-1.5 sm:pt-0">Status</Label>
              <Select value={nodeStatus} onValueChange={(v: any) => setNodeStatus(v)}>
                <SelectTrigger className="sm:col-span-3"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="online">Online</SelectItem>
                  <SelectItem value="offline">Offline</SelectItem>
                  <SelectItem value="degraded">Degraded</SelectItem>
                  <SelectItem value="maintenance">Maintenance</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsNodeDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveNode} disabled={saveNodeMutation.isPending || isDemoMode} title={isDemoMode ? "Not available in demo mode" : undefined}>
              {saveNodeMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Node
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );
}
