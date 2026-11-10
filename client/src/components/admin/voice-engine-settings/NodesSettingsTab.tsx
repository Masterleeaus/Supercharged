
/**
 * Admin Voice Engine Settings
 * Manages API keys, active providers, FreeSWITCH nodes, and SIP trunking templates.
 */
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Trash2, Edit, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { RefetchOptions, QueryObserverResult, UseMutationResult } from "@tanstack/react-query";
import { FreeSwitchNode, NodeStatusBadge } from "@/components/admin/voice-engine-settings/shared";

export interface NodesSettingsTabProps {
  refetchNodes: (options?: RefetchOptions) => Promise<QueryObserverResult<NoInfer<{ success: boolean; data: FreeSwitchNode[]; }>, Error>>;
  isDemoMode: boolean;
  toast: ReturnType<typeof useToast>["toast"];
  handleOpenAddDialog: () => void;
  nodes: FreeSwitchNode[];
  handleOpenEditDialog: (node: FreeSwitchNode) => void;
  deleteNodeMutation: UseMutationResult<any, any, string, unknown>;
}

export function NodesSettingsTab({ refetchNodes, isDemoMode, toast, handleOpenAddDialog, nodes, handleOpenEditDialog, deleteNodeMutation }: NodesSettingsTabProps) {
  return (
    <TabsContent value="nodes" className="space-y-4 mt-4">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="text-lg font-semibold">FreeSWITCH Cluster Nodes</h3>
              <p className="text-sm text-muted-foreground">Register FreeSWITCH instances used to process inbound/outbound SIP calls.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => refetchNodes()}><RefreshCw className="h-4 w-4 mr-1" /> Refresh</Button>
              <Button size="sm" onClick={() => { if (isDemoMode) { toast({ title: "Demo Mode", description: "Adding nodes is disabled in demo mode.", variant: "destructive" }); return; } handleOpenAddDialog(); }} disabled={isDemoMode} title={isDemoMode ? "Not available in demo mode" : undefined}><Plus className="h-4 w-4 mr-1" /> Add Node</Button>
            </div>
          </div>
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Node Name</TableHead>
                  <TableHead>ESL Host</TableHead>
                  <TableHead>SIP Host</TableHead>
                  <TableHead>WS Port</TableHead>
                  <TableHead>Concurrency</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {nodes.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      No FreeSWITCH nodes registered. Click "Add Node" to add your first server.
                    </TableCell>
                  </TableRow>
                ) : (
                  nodes.map((node) => (
                    <TableRow key={node.id}>
                      <TableCell className="font-medium">{node.name}</TableCell>
                      <TableCell className="font-mono text-xs">{node.esl_host}:{node.esl_port}</TableCell>
                      <TableCell className="font-mono text-xs">{node.sip_host}:{node.sip_port}</TableCell>
                      <TableCell className="font-mono text-xs">{node.ws_port}</TableCell>
                      <TableCell>{node.active_calls} / {node.max_calls}</TableCell>
                      <TableCell><NodeStatusBadge status={node.status} /></TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="icon" onClick={() => { if (isDemoMode) { toast({ title: "Demo Mode", description: "Editing nodes is disabled in demo mode.", variant: "destructive" }); return; } handleOpenEditDialog(node); }} disabled={isDemoMode} title={isDemoMode ? "Not available in demo mode" : undefined}><Edit className="h-4 w-4" /></Button>
                          <Button variant="ghost" size="icon" className="text-red-500 hover:text-red-700"
                            onClick={() => { if (isDemoMode) { toast({ title: "Demo Mode", description: "Deleting nodes is disabled in demo mode.", variant: "destructive" }); return; } if (confirm("Are you sure you want to delete this FreeSWITCH node?")) deleteNodeMutation.mutate(node.id); }}
                            disabled={isDemoMode} title={isDemoMode ? "Not available in demo mode" : undefined}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
  );
}
