
/**
 * Admin Voice Engine Settings
 * Manages API keys, active providers, FreeSWITCH nodes, and SIP trunking templates.
 */
// import { useState } from "react";
// import { useQuery, useMutation } from "@tanstack/react-query";
// import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
// import { Button } from "@/components/ui/button";
// import { Input } from "@/components/ui/input";
// import { Label } from "@/components/ui/label";
// import { Badge } from "@/components/ui/badge";
// import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
// import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
// import {
//   Table,
//   TableBody,
//   TableCell,
//   TableHead,
//   TableHeader,
//   TableRow,
// } from "@/components/ui/table";
// import {
//   Dialog,
//   DialogContent,
//   DialogDescription,
//   DialogHeader,
//   DialogTitle,
//   DialogFooter,
// } from "@/components/ui/dialog";
// import {
//   Loader2,
//   CheckCircle2,
//   XCircle,
//   Key,
//   Mic,
//   Brain,
//   Volume2,
//   Save,
//   TestTube,
//   Eye,
//   EyeOff,
//   Plus,
//   Trash2,
//   Edit,
//   Phone,
//   Server,
//   RefreshCw,
//   Copy,
//   Check,
//   Info,
//   Database,
//   HardDrive,
//   Cloud,
// } from "lucide-react";
// import { queryClient, apiRequest } from "@/lib/queryClient";
// import { useToast } from "@/hooks/use-toast";

// interface ProviderInfo {
//   name: string;
//   hasKey: boolean;
//   maskedKey: string;
// }

// interface ProviderSettings {
//   stt: { activeProvider: string; defaultModel: string; deepgramModel: string; sarvamModel: string; providers: Record<string, ProviderInfo> };
//   llm: { activeProvider: string; defaultModel: string; providers: Record<string, ProviderInfo> };
//   tts: { activeProvider: string; defaultModel: string; deepgramModel: string; sarvamModel: string; providers: Record<string, ProviderInfo> };
//   freeswitch: { eslHost: string; eslPort: number; eslPassword: string };
//   pluginEnabled: boolean;
// }

// interface FreeSwitchNode {
//   id: string;
//   name: string;
//   esl_host: string;
//   esl_port: number;
//   esl_password?: string;
//   sip_host: string;
//   sip_port: number;
//   ws_port: number;
//   status: 'online' | 'offline' | 'degraded' | 'maintenance';
//   active_calls: number;
//   max_calls: number;
//   created_at: string;
//   updated_at: string;
// }

// function StatusBadge({ hasKey }: { hasKey: boolean }) {
//   return hasKey ? (
//     <Badge variant="secondary" className="text-emerald-600 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30">
//       <CheckCircle2 className="h-3 w-3 mr-1" /> Configured
//     </Badge>
//   ) : (
//     <Badge variant="secondary" className="text-red-500 border-red-400 bg-red-50 dark:bg-red-950/30">
//       <XCircle className="h-3 w-3 mr-1" /> Not Set
//     </Badge>
//   );
// }

// function NodeStatusBadge({ status }: { status: string }) {
//   const styles: Record<string, string> = {
//     online: "text-emerald-600 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30",
//     offline: "text-red-500 border-red-400 bg-red-50 dark:bg-red-950/30",
//     degraded: "text-amber-600 border-amber-500 bg-amber-50 dark:bg-amber-950/30",
//     maintenance: "text-blue-500 border-blue-400 bg-blue-50 dark:bg-blue-950/30",
//   };
//   return (
//     <Badge variant="secondary" className={styles[status] || styles.offline}>
//       {status}
//     </Badge>
//   );
// }

// function ProviderKeyCard({
//   provider, label, currentMasked, hasKey, onSave, onTest, isTesting, testResult,
// }: {
//   provider: string; label: string; currentMasked: string; hasKey: boolean;
//   onSave: (key: string) => void; onTest: () => void;
//   isTesting: boolean; testResult: { connected: boolean; details: string } | null;
// }) {
//   const [value, setValue] = useState("");
//   const [showKey, setShowKey] = useState(false);

//   return (
//     <Card className="border border-border/60">
//       <CardHeader className="pb-3">
//         <div className="flex items-center justify-between">
//           <div className="flex items-center gap-2">
//             <Key className="h-4 w-4 text-muted-foreground" />
//             <CardTitle className="text-base">{label}</CardTitle>
//           </div>
//           <StatusBadge hasKey={hasKey} />
//         </div>
//         {hasKey && <CardDescription className="text-xs font-mono mt-1">{currentMasked}</CardDescription>}
//       </CardHeader>
//       <CardContent className="space-y-3">
//         <div className="flex flex-wrap gap-2">
//           <div className="flex flex-1 min-w-[180px] items-center rounded-md border border-input bg-background pr-1 focus-within:ring-1 focus-within:ring-ring">
//             <Input
//               type={showKey ? "text" : "password"}
//               placeholder={hasKey ? "Enter new key to update..." : "Enter API key..."}
//               value={value}
//               onChange={(e) => setValue(e.target.value)}
//               className="border-0 shadow-none focus-visible:ring-0"
//             />
//             <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0"
//               onClick={() => setShowKey(!showKey)}>
//               {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
//             </Button>
//           </div>
//           <Button size="sm" className="shrink-0" onClick={() => { onSave(value); setValue(""); }} disabled={!value.trim()}>
//             <Save className="h-3.5 w-3.5 mr-1" /> Save
//           </Button>
//         </div>
//         <div className="flex flex-wrap items-center gap-2">
//           <Button variant="outline" size="sm" className="shrink-0" onClick={onTest} disabled={!hasKey || isTesting}>
//             {isTesting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <TestTube className="h-3.5 w-3.5 mr-1" />}
//             Test
//           </Button>
//           {testResult && (
//             <span className={`text-xs ${testResult.connected ? "text-emerald-600" : "text-red-500"}`}>
//               {testResult.details}
//             </span>
//           )}
//         </div>
//       </CardContent>
//     </Card>
//   );
// }

// // ── Storage Settings Tab ──────────────────────────────────────────────────────

// type StorageProvider = 'local' | 's3' | 'gcs' | 'do_spaces' | 'wasabi';

// interface StorageConfig {
//   provider: StorageProvider;
//   retentionDays: number;
//   bucket: string;
//   region: string;
//   accessKey: string;
//   secretKey: string;
//   endpoint: string;
//   gcsBucket: string;
//   gcsProjectId: string;
//   gcsCredentials: string;
// }

// const STORAGE_PROVIDERS: { value: StorageProvider; label: string; icon: React.ReactNode; description: string; color: string }[] = [
//   { value: 'local',     label: 'Local Storage',        icon: <HardDrive className="h-5 w-5" />, description: 'Store recordings on the server disk. Simple and free, but not recommended for production.', color: 'slate' },
//   { value: 's3',        label: 'AWS S3',               icon: <Cloud className="h-5 w-5" />,     description: 'Store recordings in Amazon S3. Highly scalable and durable.', color: 'orange' },
//   { value: 'gcs',       label: 'Google Cloud Storage', icon: <Cloud className="h-5 w-5" />,     description: 'Store recordings in Google Cloud Storage (GCS).', color: 'blue' },
//   { value: 'do_spaces', label: 'DigitalOcean Spaces',  icon: <Cloud className="h-5 w-5" />,     description: 'S3-compatible object storage from DigitalOcean.', color: 'indigo' },
//   { value: 'wasabi',    label: 'Wasabi',               icon: <Cloud className="h-5 w-5" />,     description: 'Low-cost S3-compatible hot cloud storage.', color: 'green' },
// ];

// function StorageSettingsTab() {
//   const { toast } = useToast();
//   const [showSecret, setShowSecret] = useState(false);
//   const [isTesting, setIsTesting] = useState(false);
//   const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

//   const [config, setConfig] = useState<StorageConfig>({
//     provider: 'local',
//     retentionDays: 30,
//     bucket: '',
//     region: '',
//     accessKey: '',
//     secretKey: '',
//     endpoint: '',
//     gcsBucket: '',
//     gcsProjectId: '',
//     gcsCredentials: '',
//   });

//   // Load existing config
//   const { isLoading } = useQuery<{ success: boolean; data: Partial<StorageConfig> }>({
//     queryKey: ['/api/voice-engine/admin/storage'],
//     staleTime: 30000,
//     select: (data) => data,
//     // @ts-ignore
//     onSuccess: (data: any) => {
//       if (data?.data) {
//         setConfig(prev => ({ ...prev, ...data.data }));
//       }
//     },
//   });

//   const saveMutation = useMutation({
//     mutationFn: async () => {
//       const res = await apiRequest('POST', '/api/voice-engine/admin/storage', config);
//       if (!res.ok) {
//         const err = await res.json().catch(() => ({}));
//         throw new Error(err.error || 'Failed to save');
//       }
//       return res.json();
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({ queryKey: ['/api/voice-engine/admin/storage'] });
//       toast({ title: 'Storage settings saved', description: 'Recording storage configuration updated successfully.' });
//     },
//     onError: (err: any) => {
//       toast({ title: 'Save failed', description: err.message, variant: 'destructive' });
//     },
//   });

//   const handleTest = async () => {
//     setIsTesting(true);
//     setTestResult(null);
//     try {
//       const res = await apiRequest('POST', '/api/voice-engine/admin/storage/test', config);
//       const result = await res.json();
//       setTestResult({ ok: result.success, message: result.message || (result.success ? 'Connection successful' : 'Connection failed') });
//     } catch {
//       setTestResult({ ok: false, message: 'Test request failed' });
//     } finally {
//       setIsTesting(false);
//     }
//   };

//   const set = (field: keyof StorageConfig, value: any) => setConfig(prev => ({ ...prev, [field]: value }));

//   const needsS3Fields = ['s3', 'do_spaces', 'wasabi'].includes(config.provider);
//   const needsEndpoint = ['do_spaces', 'wasabi'].includes(config.provider);
//   const needsGCSFields = config.provider === 'gcs';

//   if (isLoading) {
//     return <div className="flex items-center justify-center p-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
//   }

//   return (
//     <div className="space-y-6">
//       <div>
//         <h3 className="text-lg font-semibold">Call Recording Storage</h3>
//         <p className="text-sm text-muted-foreground mt-1">
//           Configure where call recordings from the Custom Voice Engine are stored. By default, recordings are saved to the local server disk.
//         </p>
//       </div>

//       {/* Provider Selection */}
//       <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
//         {STORAGE_PROVIDERS.map((p) => {
//           const isActive = config.provider === p.value;
//           return (
//             <button
//               key={p.value}
//               type="button"
//               onClick={() => { set('provider', p.value); setTestResult(null); }}
//               data-testid={`storage-provider-${p.value}`}
//               className={`w-full text-left rounded-xl border-2 p-4 transition-all focus:outline-none ${
//                 isActive
//                   ? 'border-primary bg-primary/5 shadow-sm'
//                   : 'border-border/60 bg-card hover:border-primary/40 hover:bg-muted/30'
//               }`}
//             >
//               <div className="flex items-start gap-3">
//                 <div className={`mt-0.5 p-2 rounded-lg ${isActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
//                   {p.icon}
//                 </div>
//                 <div className="flex-1 min-w-0">
//                   <div className="flex items-center gap-2">
//                     <span className="font-semibold text-sm">{p.label}</span>
//                     {isActive && <Badge variant="secondary" className="text-primary border-primary/30 bg-primary/10 text-[10px] px-1.5 py-0">Active</Badge>}
//                   </div>
//                   <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{p.description}</p>
//                 </div>
//               </div>
//             </button>
//           );
//         })}
//       </div>

//       {/* Credential Fields */}
//       {config.provider !== 'local' && (
//         <Card className="border border-border/70">
//           <CardHeader className="pb-4">
//             <CardTitle className="text-base">
//               {STORAGE_PROVIDERS.find(p => p.value === config.provider)?.label} Configuration
//             </CardTitle>
//             <CardDescription>
//               {needsS3Fields && 'Enter your S3-compatible storage credentials.'}
//               {needsGCSFields && 'Enter your Google Cloud Storage credentials.'}
//             </CardDescription>
//           </CardHeader>
//           <CardContent className="space-y-4">
//             {needsS3Fields && (
//               <>
//                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
//                   <div className="space-y-1.5">
//                     <Label htmlFor="ve-storage-bucket">Bucket Name *</Label>
//                     <Input id="ve-storage-bucket" placeholder="my-recordings-bucket" value={config.bucket}
//                       onChange={e => set('bucket', e.target.value)} data-testid="input-storage-bucket" />
//                   </div>
//                   <div className="space-y-1.5">
//                     <Label htmlFor="ve-storage-region">Region *</Label>
//                     <Input id="ve-storage-region" placeholder={config.provider === 'do_spaces' ? 'nyc3' : config.provider === 'wasabi' ? 'us-east-1' : 'us-east-1'}
//                       value={config.region} onChange={e => set('region', e.target.value)} data-testid="input-storage-region" />
//                   </div>
//                 </div>
//                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
//                   <div className="space-y-1.5">
//                     <Label htmlFor="ve-storage-access-key">Access Key ID *</Label>
//                     <Input id="ve-storage-access-key" placeholder="AKIAIOSFODNN7EXAMPLE" value={config.accessKey}
//                       onChange={e => set('accessKey', e.target.value)} data-testid="input-storage-access-key" />
//                   </div>
//                   <div className="space-y-1.5">
//                     <Label htmlFor="ve-storage-secret-key">Secret Access Key *</Label>
//                     <div className="relative">
//                       <Input id="ve-storage-secret-key" type={showSecret ? 'text' : 'password'}
//                         placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
//                         value={config.secretKey} onChange={e => set('secretKey', e.target.value)}
//                         className="pr-8" data-testid="input-storage-secret-key" />
//                       <Button variant="ghost" size="icon" className="absolute right-0 top-0 h-full w-8"
//                         onClick={() => setShowSecret(v => !v)}>
//                         {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
//                       </Button>
//                     </div>
//                   </div>
//                 </div>
//                 {needsEndpoint && (
//                   <div className="space-y-1.5">
//                     <Label htmlFor="ve-storage-endpoint">
//                       Custom Endpoint URL *
//                       <span className="text-muted-foreground font-normal ml-1 text-xs">
//                         ({config.provider === 'do_spaces' ? 'e.g. https://nyc3.digitaloceanspaces.com' : 'e.g. https://s3.wasabisys.com'})
//                       </span>
//                     </Label>
//                     <Input id="ve-storage-endpoint" placeholder={config.provider === 'do_spaces' ? 'https://nyc3.digitaloceanspaces.com' : 'https://s3.wasabisys.com'}
//                       value={config.endpoint} onChange={e => set('endpoint', e.target.value)} data-testid="input-storage-endpoint" />
//                   </div>
//                 )}
//               </>
//             )}

//             {needsGCSFields && (
//               <>
//                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
//                   <div className="space-y-1.5">
//                     <Label htmlFor="ve-gcs-bucket">Bucket Name *</Label>
//                     <Input id="ve-gcs-bucket" placeholder="my-recordings-bucket" value={config.gcsBucket}
//                       onChange={e => set('gcsBucket', e.target.value)} />
//                   </div>
//                   <div className="space-y-1.5">
//                     <Label htmlFor="ve-gcs-project">Project ID *</Label>
//                     <Input id="ve-gcs-project" placeholder="my-gcp-project-123" value={config.gcsProjectId}
//                       onChange={e => set('gcsProjectId', e.target.value)} />
//                   </div>
//                 </div>
//                 <div className="space-y-1.5">
//                   <Label htmlFor="ve-gcs-creds">Service Account JSON *</Label>
//                   <textarea
//                     id="ve-gcs-creds"
//                     className="w-full min-h-[140px] rounded-md border border-input bg-background px-3 py-2 text-xs font-mono shadow-sm focus:outline-none focus:ring-1 focus:ring-ring resize-y"
//                     placeholder={'{\n  "type": "service_account",\n  "project_id": "...",\n  "private_key": "...",\n  "client_email": "..."\n}'}
//                     value={config.gcsCredentials}
//                     onChange={e => set('gcsCredentials', e.target.value)}
//                   />
//                   <p className="text-xs text-muted-foreground">Paste the full service account JSON from Google Cloud Console.</p>
//                 </div>
//               </>
//             )}
//           </CardContent>
//         </Card>
//       )}

//       {/* Retention + Actions */}
//       <Card className="border border-border/70">
//         <CardContent className="pt-5 space-y-4">
//           <div className="flex flex-wrap items-end gap-6">
//             <div className="space-y-1.5">
//               <Label htmlFor="ve-retention">Retention Period (days)</Label>
//               <div className="flex items-center gap-2">
//                 <Input id="ve-retention" type="number" min={0} max={3650} className="w-28"
//                   value={config.retentionDays}
//                   onChange={e => set('retentionDays', parseInt(e.target.value) || 0)}
//                   data-testid="input-storage-retention" />
//                 <span className="text-sm text-muted-foreground">days <span className="text-xs">(0 = keep forever)</span></span>
//               </div>
//             </div>

//             <div className="flex items-center gap-3 ml-auto flex-wrap">
//               {testResult && (
//                 <div className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border ${
//                   testResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/30 dark:border-emerald-800 dark:text-emerald-400'
//                                : 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-800 dark:text-red-400'
//                 }`}>
//                   {testResult.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
//                   {testResult.message}
//                 </div>
//               )}
//               {config.provider !== 'local' && (
//                 <Button variant="outline" onClick={handleTest} disabled={isTesting} data-testid="button-test-storage">
//                   {isTesting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <TestTube className="h-4 w-4 mr-2" />}
//                   Test Connection
//                 </Button>
//               )}
//               <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-storage">
//                 {saveMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
//                 Save Settings
//               </Button>
//             </div>
//           </div>
//         </CardContent>
//       </Card>
//     </div>
//   );
// }

// export default function VoiceEngineSettings() {
//   const { toast } = useToast();
//   const [activeTab, setActiveTab] = useState("speech");
//   const [testResults, setTestResults] = useState<Record<string, { connected: boolean; details: string }>>({});
//   const [testingProvider, setTestingProvider] = useState<string | null>(null);

//   // FreeSWITCH Node Form State
//   const [isNodeDialogOpen, setIsNodeDialogOpen] = useState(false);
//   const [editingNode, setEditingNode] = useState<FreeSwitchNode | null>(null);
//   const [nodeName, setNodeName] = useState("");
//   const [eslHost, setEslHost] = useState("127.0.0.1");
//   const [eslPort, setEslPort] = useState("8021");
//   const [eslPassword, setEslPassword] = useState("ClueCon");
//   const [sipHost, setSipHost] = useState("");
//   const [sipPort, setSipPort] = useState("5060");
//   const [wsPort, setWsPort] = useState("8089");
//   const [maxCalls, setMaxCalls] = useState("100");
//   const [nodeStatus, setNodeStatus] = useState<'online' | 'offline' | 'degraded' | 'maintenance'>("offline");
//   const [orSearch, setOrSearch] = useState("");
//   // SIP Provider configuration template select
//   const [selectedSipProvider, setSelectedSipProvider] = useState("twilio");
//   const [copiedText, setCopiedText] = useState<string | null>(null);

//   // Queries
//   const { data: keysData, isLoading: isKeysLoading } = useQuery<{ success: boolean; data: ProviderSettings }>({
//     queryKey: ["/api/voice-engine/admin/provider-keys"],
//     staleTime: 30000,
//   });

//   const { data: nodesData, isLoading: isNodesLoading, refetch: refetchNodes } = useQuery<{ success: boolean; data: FreeSwitchNode[] }>({
//     queryKey: ["/api/voice-engine/admin/settings/nodes"],
//     staleTime: 30000,
//   });

//   const settings = keysData?.data;
//   const nodes = nodesData?.data || [];



//   const { data: orModelsData, isLoading: isOrModelsLoading } = useQuery<{
//   success: boolean;
//   data: { id: string; name: string; context_length: number }[];
// }>({
//   queryKey: ["/api/voice-engine/admin/provider-keys/openrouter-models"],
//   staleTime: 5 * 60 * 1000,
//   enabled: !!settings, // settings load hone ke baad hi fetch karo
// });

// const orModels = orModelsData?.data ?? [];

//   // Mutations
//   const updateMutation = useMutation({
//     mutationFn: async (body: Record<string, any>) => {
//       const res = await apiRequest("PUT", "/api/voice-engine/admin/provider-keys", body);
//       return res.json();
//     },
//     onSuccess: () => {
//       queryClient.invalidateQueries({ queryKey: ["/api/voice-engine/admin/provider-keys"] });
//       toast({ title: "Settings saved", description: "Provider settings updated successfully." });
//     },
//     onError: (err: any) => {
//       toast({ title: "Error", description: err.message, variant: "destructive" });
//     },
//   });

//   const testProvider = async (provider: string) => {
//     setTestingProvider(provider);
//     try {
//       const res = await apiRequest("POST", `/api/voice-engine/admin/provider-keys/test/${provider}`);
//       const result = await res.json();
//       setTestResults((prev) => ({ ...prev, [provider]: result.data }));
//     } catch {
//       setTestResults((prev) => ({ ...prev, [provider]: { connected: false, details: "Test failed" } }));
//     } finally {
//       setTestingProvider(null);
//     }
//   };

//   // FreeSWITCH Node CRUD Mutations
//   const saveNodeMutation = useMutation({
//     mutationFn: async (payload: any) => {
//       if (editingNode) {
//         const res = await apiRequest("PUT", `/api/voice-engine/admin/settings/nodes/${editingNode.id}`, payload);
//         return res.json();
//       } else {
//         const res = await apiRequest("POST", "/api/voice-engine/admin/settings/nodes", payload);
//         return res.json();
//       }
//     },
//     onSuccess: () => {
//       refetchNodes();
//       setIsNodeDialogOpen(false);
//       resetNodeForm();
//       toast({
//         title: editingNode ? "Node Updated" : "Node Added",
//         description: `FreeSWITCH node has been successfully ${editingNode ? "updated" : "added"}.`,
//       });
//     },
//     onError: (err: any) => {
//       toast({ title: "Error Saving Node", description: err.message, variant: "destructive" });
//     },
//   });

//   const deleteNodeMutation = useMutation({
//     mutationFn: async (id: string) => {
//       const res = await apiRequest("DELETE", `/api/voice-engine/admin/settings/nodes/${id}`);
//       return res.json();
//     },
//     onSuccess: () => {
//       refetchNodes();
//       toast({
//         title: "Node Deleted",
//         description: "FreeSWITCH node deleted successfully.",
//       });
//     },
//     onError: (err: any) => {
//       toast({ title: "Error Deleting Node", description: err.message, variant: "destructive" });
//     },
//   });

//   const resetNodeForm = () => {
//     setEditingNode(null);
//     setNodeName("");
//     setEslHost("127.0.0.1");
//     setEslPort("8021");
//     setEslPassword("ClueCon");
//     setSipHost("");
//     setSipPort("5060");
//     setWsPort("8089");
//     setMaxCalls("100");
//     setNodeStatus("offline");
//   };

//   const handleOpenAddDialog = () => {
//     resetNodeForm();
//     setIsNodeDialogOpen(true);
//   };

//   const handleOpenEditDialog = (node: FreeSwitchNode) => {
//     setEditingNode(node);
//     setNodeName(node.name);
//     setEslHost(node.esl_host);
//     setEslPort(node.esl_port.toString());
//     setEslPassword(node.esl_password || "ClueCon");
//     setSipHost(node.sip_host);
//     setSipPort(node.sip_port.toString());
//     setWsPort(node.ws_port.toString());
//     setMaxCalls(node.max_calls.toString());
//     setNodeStatus(node.status);
//     setIsNodeDialogOpen(true);
//   };

//   const handleSaveNode = () => {
//     if (!nodeName.trim() || !sipHost.trim()) {
//       toast({ title: "Validation Error", description: "Node Name and SIP Host are required.", variant: "destructive" });
//       return;
//     }

//     const payload = {
//       name: nodeName,
//       eslHost,
//       eslPort: parseInt(eslPort) || 8021,
//       eslPassword,
//       sipHost,
//       sipPort: parseInt(sipPort) || 5060,
//       wsPort: parseInt(wsPort) || 8089,
//       maxCalls: parseInt(maxCalls) || 100,
//       status: nodeStatus,
//     };

//     saveNodeMutation.mutate(payload);
//   };

//   const handleCopy = (text: string, label: string) => {
//     navigator.clipboard.writeText(text);
//     setCopiedText(label);
//     setTimeout(() => setCopiedText(null), 2000);
//   };

//   if (isKeysLoading || isNodesLoading) {
//     return (
//       <div className="flex items-center justify-center p-12">
//         <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
//       </div>
//     );
//   }

//   if (!settings) {
//     return (
//       <div className="text-center p-8 text-muted-foreground">
//         Failed to load voice engine settings. Make sure the plugin migration has been applied.
//       </div>
//     );
//   }

//   // Telephony config scripts templates
//   const sipTemplates: Record<string, { guide: string; gatewayXml: string }> = {
//     twilio: {
//       guide: `1. Log in to Twilio Console and go to Elastic SIP Trunking > Trunks.\n2. Create a new SIP Trunk. Under Termination, point the SIP URI to sip:<freeswitch-ip>:5060.\n3. Under Origination, add your FreeSWITCH IP as an Origination URI: sip:<freeswitch-ip>.\n4. Save and configure the gateway file below in FreeSWITCH.`,
//       gatewayXml: `<gateway name="twilio">\n  <param name="username" value="YOUR_TWILIO_TRUNK_SID"/>\n  <param name="password" value="YOUR_TWILIO_TRUNK_PASSWORD"/>\n  <param name="proxy" value="YOUR_TWILIO_TRUNK.pstn.twilio.com"/>\n  <param name="register" value="false"/>\n</gateway>`
//     },
//     telnyx: {
//       guide: `1. Log in to Telnyx Portal and create a SIP Connection (Credential/IP authentication).\n2. Create an Outbound Voice Profile and map it to your SIP connection.\n3. Buy a phone number (DID) and assign it to route calls to your SIP Connection.\n4. Create the FreeSWITCH Gateway profile XML using the credentials.`,
//       gatewayXml: `<gateway name="telnyx">\n  <param name="username" value="YOUR_TELNYX_SIP_USERNAME"/>\n  <param name="password" value="YOUR_TELNYX_SIP_PASSWORD"/>\n  <param name="proxy" value="sip.telnyx.com"/>\n  <param name="register" value="true"/>\n  <param name="expire-seconds" value="600"/>\n</gateway>`
//     },
//     plivo: {
//       guide: `1. Log in to Plivo Console and navigate to Voice > Direct Dial > SIP Trunks.\n2. Add a new SIP Trunk pointing to your FreeSWITCH public IP address.\n3. Rent/assign a phone number and point its XML application URL to your SIP Trunk.\n4. Save the gateway credentials and apply the XML profile below.`,
//       gatewayXml: `<gateway name="plivo">\n  <param name="username" value="YOUR_PLIVO_SIP_USERNAME"/>\n  <param name="password" value="YOUR_PLIVO_SIP_PASSWORD"/>\n  <param name="proxy" value="phone.plivo.com"/>\n  <param name="register" value="true"/>\n</gateway>`
//     }
//   };

//   const dialplanXml = `<extension name="ai_voice_agent">\n  <condition field="destination_number" expression="^(\\+?\\d+)$">\n    <action application="answer"/>\n    <action application="playback" data="silence_stream://500"/>\n    <action application="set" data="tts_engine=flite"/>\n    <action application="set" data="tts_voice=slt"/>\n    <!-- Stream audio to voice-engine plugin WebSocket server -->\n    <action application="audio_fork" data="start ws://<your-node-ip>:8089/voice-engine/ws/audio/\${uuid}"/>\n    <action application="park"/>\n  </condition>\n</extension>`;

//   return (
//     <div className="space-y-6">
//       <div>
//         <h2 className="text-2xl font-bold tracking-tight">Custom Voice Engine</h2>
//         <p className="text-muted-foreground">
//           Configure AI API keys, active providers, and manage the connected FreeSWITCH nodes.
//         </p>
//       </div>

//       {/* Status Overview */}
//       <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
//         {[
//           { label: "STT", icon: Mic, provider: settings.stt.activeProvider, providers: settings.stt.providers, color: "blue" },
//           { label: "LLM", icon: Brain, provider: settings.llm.activeProvider, providers: settings.llm.providers, color: "purple" },
//           { label: "TTS", icon: Volume2, provider: settings.tts.activeProvider, providers: settings.tts.providers, color: "orange" },
//         ].map(({ label, icon: Icon, provider, providers, color }) => {
//           const active = providers[provider];
//           return (
//             <Card key={label} className={`border-${color}-200 dark:border-${color}-800/50`}>
//               <CardContent className="p-4 flex items-center gap-3">
//                 <div className={`p-2 rounded-lg bg-${color}-100 dark:bg-${color}-950/40`}>
//                   <Icon className={`h-5 w-5 text-${color}-600 dark:text-${color}-400`} />
//                 </div>
//                 <div className="flex-1 min-w-0">
//                   <p className="text-sm font-medium">{label}</p>
//                   <p className="text-xs text-muted-foreground capitalize">{active?.name || provider}</p>
//                 </div>
//                 <StatusBadge hasKey={active?.hasKey ?? false} />
//               </CardContent>
//             </Card>
//           );
//         })}
//         <Card className="border-emerald-200 dark:border-emerald-800/50">
//           <CardContent className="p-4 flex items-center gap-3">
//             <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-950/40">
//               <Server className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
//             </div>
//             <div className="flex-1 min-w-0">
//               <p className="text-sm font-medium">FS Nodes</p>
//               <p className="text-xs text-muted-foreground">
//                 {nodes.filter(n => n.status === 'online').length} / {nodes.length} Online
//               </p>
//             </div>
//             <Badge variant="outline" className="border-emerald-500 text-emerald-600">Active</Badge>
//           </CardContent>
//         </Card>
//       </div>

//       {/* Provider Management Tabs */}
//       <Tabs value={activeTab} onValueChange={setActiveTab}>
//         <TabsList className="grid w-full grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-1 mb-4 h-auto p-1 bg-muted/60">
//           <TabsTrigger value="speech" data-testid="ve-tab-speech" className="py-2.5">
//             <Mic className="h-4 w-4 mr-2" />Speech (STT/TTS)
//           </TabsTrigger>
//           <TabsTrigger value="llm" data-testid="ve-tab-llm" className="py-2.5">
//             <Brain className="h-4 w-4 mr-2" />LLM
//           </TabsTrigger>
//           <TabsTrigger value="nodes" data-testid="ve-tab-nodes" className="py-2.5">
//             <Server className="h-4 w-4 mr-2" />FreeSWITCH Nodes
//           </TabsTrigger>
//           <TabsTrigger value="telephony" data-testid="ve-tab-telephony" className="py-2.5">
//             <Phone className="h-4 w-4 mr-2" />Telephony / SIP
//           </TabsTrigger>
//           <TabsTrigger value="storage" data-testid="ve-tab-storage" className="py-2.5">
//             <Database className="h-4 w-4 mr-2" />Storage
//           </TabsTrigger>
//         </TabsList>

//         {/* Speech (STT + TTS) Tab */}
//         <TabsContent value="speech" className="space-y-6 mt-4">
//           {/* Speech-to-Text Section */}
//           <div className="space-y-4">
//             <div className="flex items-center gap-2">
//               <Mic className="h-4 w-4 text-muted-foreground" />
//               <h3 className="text-base font-semibold">Speech-to-Text (STT)</h3>
//             </div>
//             <div className="flex flex-wrap gap-4">
//               <div className="space-y-2">
//                 <Label>Active STT Provider</Label>
//                 <Select value={settings.stt.activeProvider}
//                   onValueChange={(v) => updateMutation.mutate({ sttActiveProvider: v })}>
//                   <SelectTrigger className="w-[240px]"><SelectValue /></SelectTrigger>
//                   <SelectContent>
//                     <SelectItem value="deepgram">Deepgram</SelectItem>
//                     <SelectItem value="sarvam">Sarvam AI</SelectItem>
//                   </SelectContent>
//                 </Select>
//               </div>
//               <div className="space-y-2">
//                 <Label>Default Model</Label>
//                 <Select
//                   value={settings.stt.activeProvider === 'sarvam' ? (settings.stt.sarvamModel || "") : (settings.stt.deepgramModel || "")}
//                   onValueChange={(v) => updateMutation.mutate(
//                     settings.stt.activeProvider === 'sarvam' ? { sttSarvamModel: v } : { sttDeepgramModel: v }
//                   )}>
//                   <SelectTrigger className="w-[280px]"><SelectValue placeholder="Select a model" /></SelectTrigger>
//                   <SelectContent>
//                     {settings.stt.activeProvider === 'deepgram' ? (
//                       <>
//                         <SelectItem value="nova-2">Deepgram Nova-2 (General)</SelectItem>
//                         <SelectItem value="nova-2-phonecall">Deepgram Nova-2 (Phone)</SelectItem>
//                         <SelectItem value="nova-2-medical">Deepgram Nova-2 (Medical)</SelectItem>
//                         <SelectItem value="nova-3">Deepgram Nova-3</SelectItem>
//                         <SelectItem value="base">Deepgram Base</SelectItem>
//                         <SelectItem value="enhanced">Deepgram Enhanced</SelectItem>
//                       </>
//                     ) : (
//                       <>
//                         <SelectItem value="saaras:v3">Sarvam Saaras V3</SelectItem>
//                         <SelectItem value="saaras:v2">Sarvam Saaras V2</SelectItem>
//                       </>
//                     )}
//                   </SelectContent>
//                 </Select>
//               </div>
//             </div>
//           </div>

//           {/* Text-to-Speech Section */}
//           <div className="space-y-4">
//             <div className="flex items-center gap-2">
//               <Volume2 className="h-4 w-4 text-muted-foreground" />
//               <h3 className="text-base font-semibold">Text-to-Speech (TTS)</h3>
//             </div>
//             <div className="flex flex-wrap gap-4">
//               <div className="space-y-2">
//                 <Label>Active TTS Provider</Label>
//                 <Select value={settings.tts.activeProvider}
//                   onValueChange={(v) => updateMutation.mutate({ ttsActiveProvider: v })}>
//                   <SelectTrigger className="w-[240px]"><SelectValue /></SelectTrigger>
//                   <SelectContent>
//                     <SelectItem value="deepgram">Deepgram</SelectItem>
//                     <SelectItem value="sarvam">Sarvam AI</SelectItem>
//                   </SelectContent>
//                 </Select>
//               </div>
//               <div className="space-y-2">
//                 <Label>Default Voice Model</Label>
//                 <Select
//                   value={settings.tts.activeProvider === 'sarvam' ? (settings.tts.sarvamModel || "") : (settings.tts.deepgramModel || "")}
//                   onValueChange={(v) => updateMutation.mutate(
//                     settings.tts.activeProvider === 'sarvam' ? { ttsSarvamModel: v } : { ttsDeepgramModel: v }
//                   )}>
//                   <SelectTrigger className="w-[280px]"><SelectValue placeholder="Select a voice model" /></SelectTrigger>
//                   <SelectContent>
//                     {settings.tts.activeProvider === 'deepgram' ? (
//                       <>
//                         <SelectItem value="aura-asteria-en">Deepgram Aura Asteria (EN)</SelectItem>
//                         <SelectItem value="aura-luna-en">Deepgram Aura Luna (EN)</SelectItem>
//                         <SelectItem value="aura-orion-en">Deepgram Aura Orion (EN)</SelectItem>
//                         <SelectItem value="aura-arcas-en">Deepgram Aura Arcas (EN)</SelectItem>
//                         <SelectItem value="aura-2-thalia-en">Deepgram Aura-2 Thalia (EN)</SelectItem>
//                       </>
//                     ) : (
//                       <>
//                         <SelectItem value="bulbul:v3">Sarvam Bulbul V3</SelectItem>
//                         <SelectItem value="bulbul:v2">Sarvam Bulbul V2</SelectItem>
//                         <SelectItem value="bulbul:v1">Sarvam Bulbul V1</SelectItem>
//                       </>
//                     )}
//                   </SelectContent>
//                 </Select>
//               </div>
//             </div>
//           </div>

//           {/* Shared Provider Keys (used by both STT and TTS) */}
//           <div className="space-y-3">
//             <div className="flex items-center justify-between">
//               <h3 className="text-base font-semibold">Provider API Keys</h3>
//               <span className="text-xs text-muted-foreground">Shared between STT and TTS</span>
//             </div>
//             <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
//               <ProviderKeyCard provider="deepgram" label="Deepgram API Key"
//                 hasKey={settings.stt.providers.deepgram?.hasKey ?? false}
//                 currentMasked={settings.stt.providers.deepgram?.maskedKey ?? ""}
//                 onSave={(key) => updateMutation.mutate({ deepgramApiKey: key })}
//                 onTest={() => testProvider("deepgram")}
//                 isTesting={testingProvider === "deepgram"}
//                 testResult={testResults.deepgram ?? null} />
//               <ProviderKeyCard provider="sarvam" label="Sarvam AI API Key"
//                 hasKey={settings.stt.providers.sarvam?.hasKey ?? false}
//                 currentMasked={settings.stt.providers.sarvam?.maskedKey ?? ""}
//                 onSave={(key) => updateMutation.mutate({ sarvamApiKey: key })}
//                 onTest={() => testProvider("sarvam")}
//                 isTesting={testingProvider === "sarvam"}
//                 testResult={testResults.sarvam ?? null} />
//             </div>
//           </div>
//         </TabsContent>

//         {/* LLM Tab */}
//         <TabsContent value="llm" className="space-y-4 mt-4">
//           <div className="flex flex-wrap gap-4">
//             <div className="space-y-2">
//               <Label>Active LLM Provider</Label>
//               <Select value={settings.llm.activeProvider}
//                 onValueChange={(v) => updateMutation.mutate({ llmActiveProvider: v })}>
//                 <SelectTrigger className="w-[240px]"><SelectValue /></SelectTrigger>
//                 <SelectContent>
//                   <SelectItem value="openrouter">OpenRouter</SelectItem>
//                 </SelectContent>
//               </Select>
//             </div>
//            <div className="space-y-2">
//   <Label>Default Model</Label>
//   <Select
//     value={settings.llm.defaultModel}
//     onValueChange={(v) => updateMutation.mutate({ llmDefaultModel: v })}
//   >
//     <SelectTrigger className="w-[320px]">
//       {isOrModelsLoading ? (
//         <span className="flex items-center gap-2 text-muted-foreground">
//           <Loader2 className="h-3 w-3 animate-spin" /> Loading models...
//         </span>
//       ) : (
//         <SelectValue placeholder="Select a model" />
//       )}
//     </SelectTrigger>
//     <SelectContent className="max-h-[320px]">
//       {/* Search input */}
//       <div className="px-2 py-1.5 sticky top-0 z-10 bg-popover border-b">
//         <Input
//           placeholder="Search models..."
//           value={orSearch}
//           onChange={(e) => setOrSearch(e.target.value)}
//           className="h-7 text-xs"
//           onKeyDown={(e) => e.stopPropagation()} // prevent Select keyboard nav hijack
//         />
//       </div>

//       {isOrModelsLoading ? (
//         <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground text-xs">
//           <Loader2 className="h-4 w-4 animate-spin" /> Fetching from OpenRouter...
//         </div>
//       ) : orModels.length > 0 ? (
//         orModels
//           .filter((m) =>
//             m.name.toLowerCase().includes(orSearch.toLowerCase()) ||
//             m.id.toLowerCase().includes(orSearch.toLowerCase())
//           )
//           .slice(0, 80)
//           .map((m) => (
//             <SelectItem key={m.id} value={m.id}>
//               <div className="flex flex-col py-0.5">
//                 <span className="text-xs font-medium leading-tight">{m.name}</span>
//                 <span className="text-[10px] text-muted-foreground font-mono leading-tight">{m.id}</span>
//               </div>
//             </SelectItem>
//           ))
//       ) : (
//         // Fallback hardcoded list
//         <>
//           <SelectItem value="openai/gpt-4o-mini">GPT-4o Mini</SelectItem>
//           <SelectItem value="openai/gpt-4o">GPT-4o</SelectItem>
//           <SelectItem value="google/gemini-flash-1.5">Gemini Flash 1.5</SelectItem>
//           <SelectItem value="google/gemini-pro-1.5">Gemini Pro 1.5</SelectItem>
//           <SelectItem value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet</SelectItem>
//         </>
//       )}
//     </SelectContent>
//   </Select>
// </div>
//           </div>
//           <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
//             <ProviderKeyCard provider="openrouter" label="OpenRouter API Key"
//               hasKey={settings.llm.providers.openrouter?.hasKey ?? false}
//               currentMasked={settings.llm.providers.openrouter?.maskedKey ?? ""}
//               onSave={(key) => updateMutation.mutate({ openrouterApiKey: key })}
//               onTest={() => testProvider("openrouter")}
//               isTesting={testingProvider === "openrouter"}
//               testResult={testResults.openrouter ?? null} />
//           </div>
//         </TabsContent>

//         {/* FreeSWITCH Nodes Tab */}
//         <TabsContent value="nodes" className="space-y-4 mt-4">
//           <div className="flex justify-between items-center">
//             <div>
//               <h3 className="text-lg font-semibold">FreeSWITCH Cluster Nodes</h3>
//               <p className="text-sm text-muted-foreground">
//                 Register FreeSWITCH instances used to process inbound/outbound SIP calls.
//               </p>
//             </div>
//             <div className="flex gap-2">
//               <Button variant="outline" size="sm" onClick={() => refetchNodes()}>
//                 <RefreshCw className="h-4 w-4 mr-1" /> Refresh
//               </Button>
//               <Button size="sm" onClick={handleOpenAddDialog}>
//                 <Plus className="h-4 w-4 mr-1" /> Add Node
//               </Button>
//             </div>
//           </div>

//           <Card>
//             <Table>
//               <TableHeader>
//                 <TableRow>
//                   <TableHead>Node Name</TableHead>
//                   <TableHead>ESL Host</TableHead>
//                   <TableHead>SIP Host</TableHead>
//                   <TableHead>WS Port</TableHead>
//                   <TableHead>Concurrency</TableHead>
//                   <TableHead>Status</TableHead>
//                   <TableHead className="text-right">Actions</TableHead>
//                 </TableRow>
//               </TableHeader>
//               <TableBody>
//                 {nodes.length === 0 ? (
//                   <TableRow>
//                     <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
//                       No FreeSWITCH nodes registered. Click "Add Node" to add your first server.
//                     </TableCell>
//                   </TableRow>
//                 ) : (
//                   nodes.map((node) => (
//                     <TableRow key={node.id}>
//                       <TableCell className="font-medium">{node.name}</TableCell>
//                       <TableCell className="font-mono text-xs">{node.esl_host}:{node.esl_port}</TableCell>
//                       <TableCell className="font-mono text-xs">{node.sip_host}:{node.sip_port}</TableCell>
//                       <TableCell className="font-mono text-xs">{node.ws_port}</TableCell>
//                       <TableCell>{node.active_calls} / {node.max_calls}</TableCell>
//                       <TableCell><NodeStatusBadge status={node.status} /></TableCell>
//                       <TableCell className="text-right">
//                         <div className="flex justify-end gap-2">
//                           <Button variant="ghost" size="icon" onClick={() => handleOpenEditDialog(node)}>
//                             <Edit className="h-4 w-4" />
//                           </Button>
//                           <Button variant="ghost" size="icon" className="text-red-500 hover:text-red-700"
//                             onClick={() => {
//                               if (confirm("Are you sure you want to delete this FreeSWITCH node?")) {
//                                 deleteNodeMutation.mutate(node.id);
//                               }
//                             }}>
//                             <Trash2 className="h-4 w-4" />
//                           </Button>
//                         </div>
//                       </TableCell>
//                     </TableRow>
//                   ))
//                 )}
//               </TableBody>
//             </Table>
//           </Card>
//         </TabsContent>

//         {/* Telephony & SIP Configuration Instructions Tab */}
//         <TabsContent value="telephony" className="space-y-4 mt-4">
//           <Card className="border border-indigo-100 dark:border-indigo-950 bg-indigo-50/20 dark:bg-indigo-950/10">
//             <CardHeader className="pb-3">
//               <div className="flex items-center gap-2">
//                 <Info className="h-5 w-5 text-indigo-500" />
//                 <CardTitle className="text-lg text-indigo-900 dark:text-indigo-200">Decoupled Telephony Architecture</CardTitle>
//               </div>
//               <CardDescription>
//                 The Custom Voice Engine decouples telephony from the AI pipeline. Your SIP Providers send/receive calls through <strong>FreeSWITCH</strong> directly. FreeSWITCH streams live audio to this backend over WebSockets.
//               </CardDescription>
//             </CardHeader>
//             <CardContent>
//               <div className="flex flex-wrap gap-2 items-center justify-between text-sm py-2 px-3 bg-background rounded-lg border border-border/80">
//                 <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
//                   <Badge variant="outline">SIP Provider</Badge>
//                   <span>→</span>
//                   <Badge variant="secondary">FreeSWITCH Node</Badge>
//                   <span>→</span>
//                   <Badge className="bg-indigo-600">mod_audio_fork</Badge>
//                   <span>→</span>
//                   <Badge variant="secondary">WebSocket (Port 8089)</Badge>
//                   <span>→</span>
//                   <Badge className="bg-indigo-600">AI Voice Engine</Badge>
//                 </div>
//               </div>
//             </CardContent>
//           </Card>

//           <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
//             {/* Left/Middle: Guide and Templates */}
//             <div className="lg:col-span-2 space-y-4">
//               <Card>
//                 <CardHeader>
//                   <div className="flex justify-between items-center">
//                     <CardTitle className="text-base">1. Configure Your SIP Provider Gateway</CardTitle>
//                     <Select value={selectedSipProvider} onValueChange={setSelectedSipProvider}>
//                       <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
//                       <SelectContent>
//                         <SelectItem value="twilio">Twilio</SelectItem>
//                         <SelectItem value="telnyx">Telnyx</SelectItem>
//                         <SelectItem value="plivo">Plivo</SelectItem>
//                       </SelectContent>
//                     </Select>
//                   </div>
//                   <CardDescription className="text-xs mt-1 whitespace-pre-line leading-relaxed">
//                     {sipTemplates[selectedSipProvider].guide}
//                   </CardDescription>
//                 </CardHeader>
//                 <CardContent className="space-y-2">
//                   <div className="flex justify-between items-center">
//                     <Label className="text-xs font-semibold">FreeSWITCH Gateway configuration file (<span className="font-mono text-indigo-500">conf/sip_profiles/external/{selectedSipProvider}.xml</span>)</Label>
//                     <Button variant="ghost" size="icon" className="h-7 w-7"
//                       onClick={() => handleCopy(sipTemplates[selectedSipProvider].gatewayXml, "gateway")}>
//                       {copiedText === "gateway" ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
//                     </Button>
//                   </div>
//                   <pre className="text-xs bg-muted/60 p-3 rounded-lg overflow-x-auto font-mono max-h-[200px] border">
//                     <code>{sipTemplates[selectedSipProvider].gatewayXml}</code>
//                   </pre>
//                 </CardContent>
//               </Card>

//               <Card>
//                 <CardHeader className="pb-3">
//                   <CardTitle className="text-base">2. Configure Inbound Routing (Dialplan)</CardTitle>
//                   <CardDescription>
//                     Add this extension xml block inside your FreeSWITCH Dialplan directory (<span className="font-mono text-indigo-500">conf/dialplan/public/*.xml</span>) to bridge inbound SIP trunk calls directly into the AI pipeline.
//                   </CardDescription>
//                 </CardHeader>
//                 <CardContent className="space-y-2">
//                   <div className="flex justify-between items-center">
//                     <Label className="text-xs font-semibold">FreeSWITCH Dialplan snippet (<span className="font-mono text-indigo-500">dialplan.xml</span>)</Label>
//                     <Button variant="ghost" size="icon" className="h-7 w-7"
//                       onClick={() => handleCopy(dialplanXml, "dialplan")}>
//                       {copiedText === "dialplan" ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
//                     </Button>
//                   </div>
//                   <pre className="text-xs bg-muted/60 p-3 rounded-lg overflow-x-auto font-mono max-h-[260px] border">
//                     <code>{dialplanXml}</code>
//                   </pre>
//                 </CardContent>
//               </Card>
//             </div>

//             {/* Right: How to use / FAQ */}
//             <div className="space-y-4">
//               <Card>
//                 <CardHeader>
//                   <CardTitle className="text-base">Quick Telephony Checklist</CardTitle>
//                 </CardHeader>
//                 <CardContent className="text-xs space-y-3 leading-relaxed text-muted-foreground">
//                   <div className="flex items-start gap-2">
//                     <div className="h-5 w-5 shrink-0 rounded-full bg-slate-100 flex items-center justify-center font-bold text-slate-800">1</div>
//                     <p>Register at least one <strong>FreeSWITCH node</strong> in the "FreeSWITCH Nodes" tab on this settings page.</p>
//                   </div>
//                   <div className="flex items-start gap-2">
//                     <div className="h-5 w-5 shrink-0 rounded-full bg-slate-100 flex items-center justify-center font-bold text-slate-800">2</div>
//                     <p>Load the <strong>mod_audio_fork</strong> module in your FreeSWITCH instance to stream audio over WebSockets.</p>
//                   </div>
//                   <div className="flex items-start gap-2">
//                     <div className="h-5 w-5 shrink-0 rounded-full bg-slate-100 flex items-center justify-center font-bold text-slate-800">3</div>
//                     <p>Add the <strong>Gateway profile</strong> configuration from the left to register FreeSWITCH to your provider.</p>
//                   </div>
//                   <div className="flex items-start gap-2">
//                     <div className="h-5 w-5 shrink-0 rounded-full bg-slate-100 flex items-center justify-center font-bold text-slate-800">4</div>
//                     <p>Map your inbound DID numbers in the dialplan to start <strong>audio_fork</strong> to this server's WebSocket url.</p>
//                   </div>
//                 </CardContent>
//               </Card>

//               <Card>
//                 <CardHeader>
//                   <CardTitle className="text-base">Why decouplable?</CardTitle>
//                 </CardHeader>
//                 <CardContent className="text-xs leading-relaxed text-muted-foreground space-y-2">
//                   <p>
//                     By keeping the SIP layer on FreeSWITCH, the Custom Voice Engine isn't locked into any specific phone vendor.
//                   </p>
//                   <p>
//                     You can mix-and-match carriers (e.g. use Telnyx for SMS, Twilio for UK numbers, Plivo for Indian DIDs) and load-balance them seamlessly across your FreeSWITCH clusters.
//                   </p>
//                 </CardContent>
//               </Card>
//             </div>
//           </div>
//         </TabsContent>
//         {/* Storage Tab */}
//         <TabsContent value="storage" className="space-y-4 mt-4">
//           <StorageSettingsTab />
//         </TabsContent>
//       </Tabs>

//       {/* FreeSWITCH Node Add/Edit Dialog */}
//       <Dialog open={isNodeDialogOpen} onOpenChange={setIsNodeDialogOpen}>
//         <DialogContent className="sm:max-w-[480px]">
//           <DialogHeader>
//             <DialogTitle>{editingNode ? "Edit FreeSWITCH Node" : "Add FreeSWITCH Node"}</DialogTitle>
//             <DialogDescription>
//               Provide configuration settings for your FreeSWITCH ESL and SIP endpoints.
//             </DialogDescription>
//           </DialogHeader>

//           <div className="grid gap-4 py-4">
//             <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
//               <Label htmlFor="name" className="sm:text-right pt-1.5 sm:pt-0">Name</Label>
//               <Input id="name" value={nodeName} onChange={(e) => setNodeName(e.target.value)}
//                 placeholder="e.g. US-East-Primary" className="sm:col-span-3" />
//             </div>

//             <div className="border-t my-1 pt-3 sm:col-span-4">
//               <h4 className="text-sm font-semibold mb-1 text-indigo-600 dark:text-indigo-400">Event Socket Library (ESL)</h4>
//             </div>

//             <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
//               <Label htmlFor="eslHost" className="sm:text-right pt-1.5 sm:pt-0">ESL Host</Label>
//               <Input id="eslHost" value={eslHost} onChange={(e) => setEslHost(e.target.value)}
//                 placeholder="127.0.0.1" className="sm:col-span-3" />
//             </div>

//             <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
//               <Label htmlFor="eslPort" className="sm:text-right pt-1.5 sm:pt-0">ESL Port</Label>
//               <Input id="eslPort" value={eslPort} onChange={(e) => setEslPort(e.target.value)}
//                 placeholder="8021" className="sm:col-span-3" />
//             </div>

//             <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
//               <Label htmlFor="eslPassword" className="sm:text-right pt-1.5 sm:pt-0">ESL Pass</Label>
//               <Input id="eslPassword" type="password" value={eslPassword} onChange={(e) => setEslPassword(e.target.value)}
//                 placeholder="ClueCon" className="sm:col-span-3" />
//             </div>

//             <div className="border-t my-1 pt-3 sm:col-span-4">
//               <h4 className="text-sm font-semibold mb-1 text-indigo-600 dark:text-indigo-400">SIP &amp; WebSocket Endpoints</h4>
//             </div>

//             <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
//               <Label htmlFor="sipHost" className="sm:text-right pt-1.5 sm:pt-0">SIP Host</Label>
//               <Input id="sipHost" value={sipHost} onChange={(e) => setSipHost(e.target.value)}
//                 placeholder="e.g. 52.4.123.8" className="sm:col-span-3" />
//             </div>

//             <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
//               <Label htmlFor="sipPort" className="sm:text-right pt-1.5 sm:pt-0">SIP Port</Label>
//               <Input id="sipPort" value={sipPort} onChange={(e) => setSipPort(e.target.value)}
//                 placeholder="5060" className="sm:col-span-3" />
//             </div>

//             <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
//               <Label htmlFor="wsPort" className="sm:text-right pt-1.5 sm:pt-0">WS Port</Label>
//               <Input id="wsPort" value={wsPort} onChange={(e) => setWsPort(e.target.value)}
//                 placeholder="8089" className="sm:col-span-3" />
//             </div>

//             <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
//               <Label htmlFor="maxCalls" className="sm:text-right pt-1.5 sm:pt-0">Max Calls</Label>
//               <Input id="maxCalls" value={maxCalls} onChange={(e) => setMaxCalls(e.target.value)}
//                 placeholder="100" className="sm:col-span-3" />
//             </div>

//             <div className="grid grid-cols-1 sm:grid-cols-4 items-start sm:items-center gap-2 sm:gap-4">
//               <Label htmlFor="status" className="sm:text-right pt-1.5 sm:pt-0">Status</Label>
//               <Select value={nodeStatus} onValueChange={(v: any) => setNodeStatus(v)}>
//                 <SelectTrigger className="sm:col-span-3"><SelectValue /></SelectTrigger>
//                 <SelectContent>
//                   <SelectItem value="online">Online</SelectItem>
//                   <SelectItem value="offline">Offline</SelectItem>
//                   <SelectItem value="degraded">Degraded</SelectItem>
//                   <SelectItem value="maintenance">Maintenance</SelectItem>
//                 </SelectContent>
//               </Select>
//             </div>
//           </div>

//           <DialogFooter>
//             <Button variant="outline" onClick={() => setIsNodeDialogOpen(false)}>Cancel</Button>
//             <Button onClick={handleSaveNode} disabled={saveNodeMutation.isPending}>
//               {saveNodeMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
//               Save Node
//             </Button>
//           </DialogFooter>
//         </DialogContent>
//       </Dialog>
//     </div>
//   );
// }




import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Loader2, CheckCircle2, XCircle, Key, Mic, Brain, Volume2, Save, TestTube,
  Eye, EyeOff, Plus, Trash2, Edit, Phone, Server, RefreshCw, Copy, Check,
  Info, Database, HardDrive, Cloud,
} from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDemoMode } from "@/components/DemoModeBanner";

interface ProviderInfo {
  name: string;
  hasKey: boolean;
  maskedKey: string;
}

interface ProviderSettings {
  stt: {
    activeProvider: string;
    allowedProviders: string[];
    defaultModel: string;
    deepgramModel: string;
    sarvamModel: string;
    deepgramAllowedModels?: string[];
    sarvamAllowedModels?: string[];
    providers: Record<string, ProviderInfo>
  };
  llm: { activeProvider: string; defaultModel: string; allowedModels: string[]; providers: Record<string, ProviderInfo> };
  tts: {
    activeProvider: string;
    allowedProviders: string[];
    defaultModel: string;
    deepgramModel: string;
    sarvamModel: string;
    deepgramAllowedModels?: string[];
    sarvamAllowedModels?: string[];
    providers: Record<string, ProviderInfo>
  };
  freeswitch: { eslHost: string; eslPort: number; eslPassword: string };
  pluginEnabled: boolean;
}

interface FreeSwitchNode {
  id: string;
  name: string;
  esl_host: string;
  esl_port: number;
  esl_password?: string;
  sip_host: string;
  sip_port: number;
  ws_port: number;
  status: 'online' | 'offline' | 'degraded' | 'maintenance';
  active_calls: number;
  max_calls: number;
  created_at: string;
  updated_at: string;
}

interface SipGateway {
  id: string;
  name: string;
  username: string;
  password?: string;
  proxy: string;
  register: boolean;
  caller_id_in_from: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function StatusBadge({ hasKey }: { hasKey: boolean }) {
  return hasKey ? (
    <Badge variant="secondary" className="text-emerald-600 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30">
      <CheckCircle2 className="h-3 w-3 mr-1" /> Configured
    </Badge>
  ) : (
    <Badge variant="secondary" className="text-red-500 border-red-400 bg-red-50 dark:bg-red-950/30">
      <XCircle className="h-3 w-3 mr-1" /> Not Set
    </Badge>
  );
}

function NodeStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    online: "text-emerald-600 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30",
    offline: "text-red-500 border-red-400 bg-red-50 dark:bg-red-950/30",
    degraded: "text-amber-600 border-amber-500 bg-amber-50 dark:bg-amber-950/30",
    maintenance: "text-blue-500 border-blue-400 bg-blue-50 dark:bg-blue-950/30",
  };
  return (
    <Badge variant="secondary" className={styles[status] || styles.offline}>
      {status}
    </Badge>
  );
}

function ProviderKeyCard({
  provider, label, currentMasked, hasKey, onSave, onTest, isTesting, testResult, isDemoMode,
}: {
  provider: string; label: string; currentMasked: string; hasKey: boolean;
  onSave: (key: string) => void; onTest: () => void;
  isTesting: boolean; testResult: { connected: boolean; details: string } | null;
  isDemoMode?: boolean;
}) {
  const [value, setValue] = useState("");
  const [showKey, setShowKey] = useState(false);
  const { toast } = useToast();

  const handleSave = () => {
    if (isDemoMode) {
      toast({ title: "Demo Mode", description: "Saving API keys is disabled in demo mode.", variant: "destructive" });
      return;
    }
    onSave(value);
    setValue("");
  };

  return (
    <Card className="border border-border/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">{label}</CardTitle>
          </div>
          <StatusBadge hasKey={hasKey} />
        </div>
        {hasKey && <CardDescription className="text-xs font-mono mt-1">{currentMasked}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <div className="flex flex-1 min-w-[180px] items-center rounded-md border border-input bg-background pr-1 focus-within:ring-1 focus-within:ring-ring">
            <Input
              type={showKey ? "text" : "password"}
              placeholder={hasKey ? "Enter new key to update..." : "Enter API key..."}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="border-0 shadow-none focus-visible:ring-0"
              disabled={isDemoMode}
            />
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0"
              onClick={() => setShowKey(!showKey)}>
              {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <Button size="sm" className="shrink-0" onClick={handleSave} disabled={!value.trim() || isDemoMode}
            title={isDemoMode ? "Not available in demo mode" : undefined}>
            <Save className="h-3.5 w-3.5 mr-1" /> Save
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="shrink-0" onClick={onTest} disabled={!hasKey || isTesting}>
            {isTesting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <TestTube className="h-3.5 w-3.5 mr-1" />}
            Test Connection
          </Button>
          {testResult && (
            <span className={`text-xs ${testResult.connected ? "text-emerald-600" : "text-red-500"}`}>
              {testResult.details}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Storage Settings Tab ──────────────────────────────────────────────────────

type StorageProvider = 'local' | 's3' | 'gcs' | 'do_spaces' | 'wasabi';

interface StorageConfig {
  provider: StorageProvider;
  activeProvider: StorageProvider;
  retentionDays: number;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  endpoint: string;
  gcsBucket: string;
  gcsProjectId: string;
  gcsCredentials: string;
}

const STORAGE_PROVIDERS: { value: StorageProvider; label: string; icon: React.ReactNode; description: string }[] = [
  { value: 'local', label: 'Local Storage', icon: <HardDrive className="h-5 w-5" />, description: 'Store recordings on the server disk. Simple and free, but not recommended for production.' },
  { value: 's3', label: 'AWS S3', icon: <Cloud className="h-5 w-5" />, description: 'Store recordings in Amazon S3. Highly scalable and durable.' },
  { value: 'gcs', label: 'Google Cloud Storage', icon: <Cloud className="h-5 w-5" />, description: 'Store recordings in Google Cloud Storage (GCS).' },
  { value: 'do_spaces', label: 'DigitalOcean Spaces', icon: <Cloud className="h-5 w-5" />, description: 'S3-compatible object storage from DigitalOcean.' },
  { value: 'wasabi', label: 'Wasabi', icon: <Cloud className="h-5 w-5" />, description: 'Low-cost S3-compatible hot cloud storage.' },
];

function StorageSettingsTab() {
  const { toast } = useToast();
  const { isDemoMode } = useDemoMode();
  const [showSecret, setShowSecret] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [activeProvider, setActiveProvider] = useState<StorageProvider>('local');

  const [config, setConfig] = useState<StorageConfig>({
    provider: 'local',
    activeProvider: 'local',
    retentionDays: 30,
    bucket: '',
    region: '',
    accessKey: '',
    secretKey: '',
    endpoint: '',
    gcsBucket: '',
    gcsProjectId: '',
    gcsCredentials: '',
  });

  const { isLoading, data: storageData } = useQuery<{ success: boolean; data: Partial<StorageConfig> }>({
    queryKey: ['/api/voice-engine/admin/storage'],
    staleTime: 30000,
  });

  useEffect(() => {
    if (storageData?.data) {
      setConfig(prev => ({ ...prev, ...storageData.data }));
      if (storageData.data.activeProvider) {
        setActiveProvider(storageData.data.activeProvider);
      }
    }
  }, [storageData]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/voice-engine/admin/storage', config);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/voice-engine/admin/storage'] });
      toast({ title: 'Storage settings saved', description: 'Recording storage configuration updated successfully.' });
    },
    onError: (err: any) => {
      toast({ title: 'Save failed', description: err.message, variant: 'destructive' });
    },
  });

  const activateMutation = useMutation({
    mutationFn: async (provider: StorageProvider) => {
      const res = await apiRequest('POST', '/api/voice-engine/admin/storage/activate', { provider });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to activate');
      }
      return res.json();
    },
    onSuccess: (_, provider) => {
      setActiveProvider(provider);
      queryClient.invalidateQueries({ queryKey: ['/api/voice-engine/admin/storage'] });
      toast({
        title: 'Storage provider activated',
        description: `${STORAGE_PROVIDERS.find(p => p.value === provider)?.label} is now the active storage provider.`,
      });
    },
    onError: (err: any) => {
      toast({ title: 'Activation failed', description: err.message, variant: 'destructive' });
    },
  });

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await apiRequest('POST', '/api/voice-engine/admin/storage/test', config);
      const result = await res.json();
      setTestResult({ ok: result.success, message: result.message || (result.success ? 'Connection successful' : 'Connection failed') });
    } catch {
      setTestResult({ ok: false, message: 'Test request failed' });
    } finally {
      setIsTesting(false);
    }
  };

  const set = (field: keyof StorageConfig, value: any) => setConfig(prev => ({ ...prev, [field]: value }));

  const needsS3Fields = ['s3', 'do_spaces', 'wasabi'].includes(config.provider);
  const needsEndpoint = ['do_spaces', 'wasabi'].includes(config.provider);
  const needsGCSFields = config.provider === 'gcs';

  if (isLoading) {
    return <div className="flex items-center justify-center p-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Call Recording Storage</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Configure where call recordings are stored. Select a provider, save its credentials, then click <strong>Set Active</strong> to use it.
        </p>
      </div>

      {/* Provider Selection */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {STORAGE_PROVIDERS.map((p) => {
          const isSelected = config.provider === p.value;
          const isActive = activeProvider === p.value;

          return (
            <button
              key={p.value}
              type="button"
              onClick={() => { set('provider', p.value); setTestResult(null); }}
              data-testid={`storage-provider-${p.value}`}
              className={`w-full text-left rounded-xl border-2 p-4 transition-all focus:outline-none ${isActive
                ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20 shadow-md ring-2 ring-emerald-200 dark:ring-emerald-900'
                : isSelected
                  ? 'border-primary bg-primary/10 shadow-sm ring-2 ring-primary/20'
                  : 'border-border/60 bg-card hover:border-primary/40 hover:bg-muted/30'
                }`}
            >
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 p-2 rounded-lg ${isActive
                  ? 'bg-emerald-500 text-white'
                  : isSelected
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                  }`}>
                  {p.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm">{p.label}</span>
                    {isActive && (
                      <Badge className="bg-emerald-500 text-white text-[10px] px-1.5 py-0 gap-0.5">
                        <CheckCircle2 className="h-2.5 w-2.5" /> Active
                      </Badge>
                    )}
                    {isSelected && !isActive && (
                      <Badge variant="outline" className="text-primary border-primary/50 text-[10px] px-1.5 py-0">
                        Selected
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{p.description}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Credential Fields */}
      {config.provider !== 'local' && (
        <Card className="border border-border/70">
          <CardHeader className="pb-4">
            <CardTitle className="text-base">
              {STORAGE_PROVIDERS.find(p => p.value === config.provider)?.label} Configuration
            </CardTitle>
            <CardDescription>
              {needsS3Fields && 'Enter your S3-compatible storage credentials.'}
              {needsGCSFields && 'Enter your Google Cloud Storage credentials.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {needsS3Fields && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="ve-storage-bucket">Bucket Name *</Label>
                    <Input id="ve-storage-bucket" placeholder="my-recordings-bucket" value={config.bucket}
                      onChange={e => set('bucket', e.target.value)} data-testid="input-storage-bucket" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ve-storage-region">Region *</Label>
                    <Input id="ve-storage-region"
                      placeholder={config.provider === 'do_spaces' ? 'nyc3' : 'us-east-1'}
                      value={config.region} onChange={e => set('region', e.target.value)} data-testid="input-storage-region" />
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="ve-storage-access-key">Access Key ID *</Label>
                    <Input id="ve-storage-access-key" placeholder="AKIAIOSFODNN7EXAMPLE" value={config.accessKey}
                      onChange={e => set('accessKey', e.target.value)} data-testid="input-storage-access-key" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ve-storage-secret-key">Secret Access Key *</Label>
                    <div className="relative">
                      <Input id="ve-storage-secret-key" type={showSecret ? 'text' : 'password'}
                        placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                        value={config.secretKey} onChange={e => set('secretKey', e.target.value)}
                        className="pr-8" data-testid="input-storage-secret-key" />
                      <Button variant="ghost" size="icon" className="absolute right-0 top-0 h-full w-8"
                        onClick={() => setShowSecret(v => !v)}>
                        {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </Button>
                    </div>
                  </div>
                </div>
                {needsEndpoint && (
                  <div className="space-y-1.5">
                    <Label htmlFor="ve-storage-endpoint">
                      Custom Endpoint URL *
                      <span className="text-muted-foreground font-normal ml-1 text-xs">
                        ({config.provider === 'do_spaces' ? 'e.g. https://nyc3.digitaloceanspaces.com' : 'e.g. https://s3.wasabisys.com'})
                      </span>
                    </Label>
                    <Input id="ve-storage-endpoint"
                      placeholder={config.provider === 'do_spaces' ? 'https://nyc3.digitaloceanspaces.com' : 'https://s3.wasabisys.com'}
                      value={config.endpoint} onChange={e => set('endpoint', e.target.value)} data-testid="input-storage-endpoint" />
                  </div>
                )}
              </>
            )}

            {needsGCSFields && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="ve-gcs-bucket">Bucket Name *</Label>
                    <Input id="ve-gcs-bucket" placeholder="my-recordings-bucket" value={config.gcsBucket}
                      onChange={e => set('gcsBucket', e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ve-gcs-project">Project ID *</Label>
                    <Input id="ve-gcs-project" placeholder="my-gcp-project-123" value={config.gcsProjectId}
                      onChange={e => set('gcsProjectId', e.target.value)} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ve-gcs-creds">Service Account JSON *</Label>
                  <textarea
                    id="ve-gcs-creds"
                    className="w-full min-h-[140px] rounded-md border border-input bg-background px-3 py-2 text-xs font-mono shadow-sm focus:outline-none focus:ring-1 focus:ring-ring resize-y"
                    placeholder={'{\n  "type": "service_account",\n  "project_id": "...",\n  "private_key": "...",\n  "client_email": "..."\n}'}
                    value={config.gcsCredentials}
                    onChange={e => set('gcsCredentials', e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Paste the full service account JSON from Google Cloud Console.</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Retention + Actions */}
      <Card className="border border-border/70">
        <CardContent className="pt-5 space-y-4">
          <div className="flex flex-wrap items-end gap-6">
            <div className="space-y-1.5">
              <Label htmlFor="ve-retention">Retention Period (days)</Label>
              <div className="flex items-center gap-2">
                <Input id="ve-retention" type="number" min={0} max={3650} className="w-28"
                  value={config.retentionDays}
                  onChange={e => set('retentionDays', parseInt(e.target.value) || 0)}
                  data-testid="input-storage-retention" />
                <span className="text-sm text-muted-foreground">days <span className="text-xs">(0 = keep forever)</span></span>
              </div>
            </div>

            <div className="flex items-center gap-3 ml-auto flex-wrap">
              {/* Test Result */}
              {testResult && (
                <div className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border ${testResult.ok
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/30 dark:border-emerald-800 dark:text-emerald-400'
                  : 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-800 dark:text-red-400'
                  }`}>
                  {testResult.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                  {testResult.message}
                </div>
              )}

              {/* Test Connection - only for non-local */}
              {config.provider !== 'local' && (
                <Button variant="outline" onClick={handleTest} disabled={isTesting} data-testid="button-test-storage">
                  {isTesting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <TestTube className="h-4 w-4 mr-2" />}
                  Test Connection
                </Button>
              )}

              {/* Save Settings */}
              <Button
                variant="outline"
                onClick={() => {
                  if (isDemoMode) { toast({ title: "Demo Mode", description: "Saving storage settings is disabled in demo mode.", variant: "destructive" }); return; }
                  saveMutation.mutate();
                }}
                disabled={saveMutation.isPending || isDemoMode}
                title={isDemoMode ? "Not available in demo mode" : undefined}
                data-testid="button-save-storage"
              >
                {saveMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                Save Settings
              </Button>

              {/* Set Active */}
              <Button
                onClick={() => {
                  if (isDemoMode) { toast({ title: "Demo Mode", description: "Activating storage providers is disabled in demo mode.", variant: "destructive" }); return; }
                  activateMutation.mutate(config.provider);
                }}
                disabled={activateMutation.isPending || activeProvider === config.provider || isDemoMode}
                className="bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60"
                title={isDemoMode ? "Not available in demo mode" : undefined}
                data-testid="button-activate-storage"
              >
                {activateMutation.isPending
                  ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  : <CheckCircle2 className="h-4 w-4 mr-2" />
                }
                {activeProvider === config.provider ? 'Already Active' : 'Set Active'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function VoiceEngineSettings() {
  const { toast } = useToast();
  const { isDemoMode } = useDemoMode();
  const [activeTab, setActiveTab] = useState("speech");
  const [testResults, setTestResults] = useState<Record<string, { connected: boolean; details: string }>>({});
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [isNodeDialogOpen, setIsNodeDialogOpen] = useState(false);
  const [editingNode, setEditingNode] = useState<FreeSwitchNode | null>(null);
  const [nodeName, setNodeName] = useState("");
  const [eslHost, setEslHost] = useState("127.0.0.1");
  const [eslPort, setEslPort] = useState("8021");
  const [eslPassword, setEslPassword] = useState("ClueCon");
  const [sipHost, setSipHost] = useState("");
  const [sipPort, setSipPort] = useState("5060");
  const [wsPort, setWsPort] = useState("8089");
  const [maxCalls, setMaxCalls] = useState("100");
  const [nodeStatus, setNodeStatus] = useState<'online' | 'offline' | 'degraded' | 'maintenance'>("offline");
  const [orSearch, setOrSearch] = useState("");
  const [selectedSipProvider, setSelectedSipProvider] = useState("twilio");
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // SIP Gateways state
  const [isGatewayDialogOpen, setIsGatewayDialogOpen] = useState(false);
  const [editingGateway, setEditingGateway] = useState<SipGateway | null>(null);
  const [gwName, setGwName] = useState("");
  const [gwUsername, setGwUsername] = useState("");
  const [gwPassword, setGwPassword] = useState("");
  const [gwProxy, setGwProxy] = useState("");
  const [gwRegister, setGwRegister] = useState(false);
  const [gwCallerIdInFrom, setGwCallerIdInFrom] = useState(true);

  const { data: keysData, isLoading: isKeysLoading } = useQuery<{ success: boolean; data: ProviderSettings }>({
    queryKey: ["/api/voice-engine/admin/provider-keys"],
    staleTime: 30000,
  });

  const { data: nodesData, isLoading: isNodesLoading, refetch: refetchNodes } = useQuery<{ success: boolean; data: FreeSwitchNode[] }>({
    queryKey: ["/api/voice-engine/admin/settings/nodes"],
    staleTime: 30000,
  });

  const { data: gatewaysData, isLoading: isGatewaysLoading, refetch: refetchGateways } = useQuery<{ success: boolean; data: SipGateway[] }>({
    queryKey: ["/api/voice-engine/admin/settings/sip-gateways"],
    staleTime: 30000,
  });

  const gateways = gatewaysData?.data || [];

  const saveGatewayMutation = useMutation({
    mutationFn: async (payload: any) => {
      if (editingGateway) {
        const res = await apiRequest("PUT", `/api/voice-engine/admin/settings/sip-gateways/${editingGateway.id}`, payload);
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/voice-engine/admin/settings/sip-gateways", payload);
        return res.json();
      }
    },
    onSuccess: () => {
      refetchGateways();
      setIsGatewayDialogOpen(false);
      resetGatewayForm();
      toast({
        title: editingGateway ? "Gateway Updated" : "Gateway Added",
        description: `SIP Gateway has been successfully ${editingGateway ? "updated" : "added"}.`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Error Saving Gateway", description: err.message, variant: "destructive" });
    },
  });

  const deleteGatewayMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/voice-engine/admin/settings/sip-gateways/${id}`);
      return res.json();
    },
    onSuccess: () => {
      refetchGateways();
      toast({ title: "Gateway Deleted", description: "SIP Gateway deleted successfully." });
    },
    onError: (err: any) => {
      toast({ title: "Error Deleting Gateway", description: err.message, variant: "destructive" });
    },
  });

  const activateGatewayMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/voice-engine/admin/settings/sip-gateways/${id}/activate`);
      return res.json();
    },
    onSuccess: () => {
      refetchGateways();
      toast({ title: "Gateway Activated", description: "Selected SIP Gateway is now active." });
    },
    onError: (err: any) => {
      toast({ title: "Error Activating Gateway", description: err.message, variant: "destructive" });
    },
  });

  const resetGatewayForm = () => {
    setEditingGateway(null);
    setGwName("");
    setGwUsername("");
    setGwPassword("");
    setGwProxy("");
    setGwRegister(false);
    setGwCallerIdInFrom(true);
  };

  const handleOpenAddGatewayDialog = () => {
    resetGatewayForm();
    setIsGatewayDialogOpen(true);
  };

  const handleOpenEditGatewayDialog = (gw: SipGateway) => {
    setEditingGateway(gw);
    setGwName(gw.name);
    setGwUsername(gw.username);
    setGwPassword(gw.password || "");
    setGwProxy(gw.proxy);
    setGwRegister(gw.register);
    setGwCallerIdInFrom(gw.caller_id_in_from);
    setIsGatewayDialogOpen(true);
  };

  const handleSaveGateway = () => {
    if (!gwName.trim() || !gwUsername.trim() || !gwPassword.trim() || !gwProxy.trim()) {
      toast({ title: "Validation Error", description: "Name, Username, Password, and Proxy are required.", variant: "destructive" });
      return;
    }
    saveGatewayMutation.mutate({
      name: gwName,
      username: gwUsername,
      password: gwPassword,
      proxy: gwProxy,
      register: gwRegister,
      callerIdInFrom: gwCallerIdInFrom,
    });
  };

  const { data: orModelsData, isLoading: isOrModelsLoading } = useQuery<{
    success: boolean;
    data: { id: string; name: string; context_length: number }[];
  }>({
    queryKey: ["/api/voice-engine/admin/provider-keys/openrouter-models"],
    staleTime: 5 * 60 * 1000,
    enabled: !!keysData?.data,
  });

  const settings = keysData?.data;
  const nodes = nodesData?.data || [];
  const orModels = orModelsData?.data ?? [];

  const updateMutation = useMutation({
    mutationFn: async (body: Record<string, any>) => {
      const res = await apiRequest("PUT", "/api/voice-engine/admin/provider-keys", body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/voice-engine/admin/provider-keys"] });
      toast({ title: "Settings saved", description: "Provider settings updated successfully." });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const testProvider = async (provider: string) => {
    setTestingProvider(provider);
    try {
      const res = await apiRequest("POST", `/api/voice-engine/admin/provider-keys/test/${provider}`);
      const result = await res.json();
      setTestResults((prev) => ({ ...prev, [provider]: result.data }));
    } catch {
      setTestResults((prev) => ({ ...prev, [provider]: { connected: false, details: "Test failed" } }));
    } finally {
      setTestingProvider(null);
    }
  };

  const saveNodeMutation = useMutation({
    mutationFn: async (payload: any) => {
      if (editingNode) {
        const res = await apiRequest("PUT", `/api/voice-engine/admin/settings/nodes/${editingNode.id}`, payload);
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/voice-engine/admin/settings/nodes", payload);
        return res.json();
      }
    },
    onSuccess: () => {
      refetchNodes();
      setIsNodeDialogOpen(false);
      resetNodeForm();
      toast({
        title: editingNode ? "Node Updated" : "Node Added",
        description: `FreeSWITCH node has been successfully ${editingNode ? "updated" : "added"}.`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Error Saving Node", description: err.message, variant: "destructive" });
    },
  });

  const deleteNodeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/voice-engine/admin/settings/nodes/${id}`);
      return res.json();
    },
    onSuccess: () => {
      refetchNodes();
      toast({ title: "Node Deleted", description: "FreeSWITCH node deleted successfully." });
    },
    onError: (err: any) => {
      toast({ title: "Error Deleting Node", description: err.message, variant: "destructive" });
    },
  });

  const resetNodeForm = () => {
    setEditingNode(null);
    setNodeName("");
    setEslHost("127.0.0.1");
    setEslPort("8021");
    setEslPassword("ClueCon");
    setSipHost("");
    setSipPort("5060");
    setWsPort("8089");
    setMaxCalls("100");
    setNodeStatus("offline");
  };

  const handleOpenAddDialog = () => { resetNodeForm(); setIsNodeDialogOpen(true); };

  const handleOpenEditDialog = (node: FreeSwitchNode) => {
    setEditingNode(node);
    setNodeName(node.name);
    setEslHost(node.esl_host);
    setEslPort(node.esl_port.toString());
    setEslPassword(node.esl_password || "ClueCon");
    setSipHost(node.sip_host);
    setSipPort(node.sip_port.toString());
    setWsPort(node.ws_port.toString());
    setMaxCalls(node.max_calls.toString());
    setNodeStatus(node.status);
    setIsNodeDialogOpen(true);
  };

  const handleSaveNode = () => {
    if (!nodeName.trim() || !sipHost.trim()) {
      toast({ title: "Validation Error", description: "Node Name and SIP Host are required.", variant: "destructive" });
      return;
    }
    saveNodeMutation.mutate({
      name: nodeName,
      eslHost, eslPort: parseInt(eslPort) || 8021, eslPassword,
      sipHost, sipPort: parseInt(sipPort) || 5060,
      wsPort: parseInt(wsPort) || 8089,
      maxCalls: parseInt(maxCalls) || 100,
      status: nodeStatus,
    });
  };

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(label);
    setTimeout(() => setCopiedText(null), 2000);
  };

  if (isKeysLoading || isNodesLoading || isGatewaysLoading) {
    return <div className="flex items-center justify-center p-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  if (!settings) {
    return <div className="text-center p-8 text-muted-foreground">Failed to load voice engine settings. Make sure the plugin migration has been applied.</div>;
  }

  const sipTemplates: Record<string, { guide: string; gatewayXml: string }> = {
    twilio: {
      guide: `1. Log in to Twilio Console and go to Elastic SIP Trunking > Trunks.\n2. Create a new SIP Trunk. Under Termination, point the SIP URI to sip:<freeswitch-ip>:5060.\n3. Under Origination, add your FreeSWITCH IP as an Origination URI: sip:<freeswitch-ip>.\n4. Save and configure the gateway file below in FreeSWITCH.`,
      gatewayXml: `<gateway name="twilio">\n  <param name="username" value="YOUR_TWILIO_TRUNK_SID"/>\n  <param name="password" value="YOUR_TWILIO_TRUNK_PASSWORD"/>\n  <param name="proxy" value="YOUR_TWILIO_TRUNK.pstn.twilio.com"/>\n  <param name="register" value="false"/>\n</gateway>`
    },
    telnyx: {
      guide: `1. Log in to Telnyx Portal and create a SIP Connection (Credential/IP authentication).\n2. Create an Outbound Voice Profile and map it to your SIP connection.\n3. Buy a phone number (DID) and assign it to route calls to your SIP Connection.\n4. Create the FreeSWITCH Gateway profile XML using the credentials.`,
      gatewayXml: `<gateway name="telnyx">\n  <param name="username" value="YOUR_TELNYX_SIP_USERNAME"/>\n  <param name="password" value="YOUR_TELNYX_SIP_PASSWORD"/>\n  <param name="proxy" value="sip.telnyx.com"/>\n  <param name="register" value="true"/>\n  <param name="expire-seconds" value="600"/>\n</gateway>`
    },
    plivo: {
      guide: `1. Log in to Plivo Console and navigate to Voice > Direct Dial > SIP Trunks.\n2. Add a new SIP Trunk pointing to your FreeSWITCH public IP address.\n3. Rent/assign a phone number and point its XML application URL to your SIP Trunk.\n4. Save the gateway credentials and apply the XML profile below.`,
      gatewayXml: `<gateway name="plivo">\n  <param name="username" value="YOUR_PLIVO_SIP_USERNAME"/>\n  <param name="password" value="YOUR_PLIVO_SIP_PASSWORD"/>\n  <param name="proxy" value="phone.plivo.com"/>\n  <param name="register" value="true"/>\n</gateway>`
    },
    vonage: {
      guide: `1. Log in to Vonage API Dashboard and go to Voice > SIP Trunking.\n2. Create a new SIP Trunk pointing to your FreeSWITCH IP.\n3. Configure the Gateway settings below using your Vonage API Key and Secret.`,
      gatewayXml: `<gateway name="vonage">\n  <param name="username" value="YOUR_VONAGE_API_KEY"/>\n  <param name="password" value="YOUR_VONAGE_API_SECRET"/>\n  <param name="proxy" value="sip.nexmo.com"/>\n  <param name="register" value="true"/>\n</gateway>`
    },
    bandwidth: {
      guide: `1. Log in to Bandwidth Dashboard and configure a SIP Peer for your FreeSWITCH IP.\n2. Create an Associated Credentials set.\n3. Configure the gateway profile XML with your credentials and domain.`,
      gatewayXml: `<gateway name="bandwidth">\n  <param name="username" value="YOUR_BANDWIDTH_USERNAME"/>\n  <param name="password" value="YOUR_BANDWIDTH_PASSWORD"/>\n  <param name="proxy" value="otg.bandwidth.com"/>\n  <param name="register" value="false"/>\n</gateway>`
    },
    sinch: {
      guide: `1. Log in to Sinch Customer Portal and create a new SIP Trunk.\n2. Map the Sinch DID numbers to your FreeSWITCH public IP.\n3. Set up the SIP registration gateway using Sinch credentials.`,
      gatewayXml: `<gateway name="sinch">\n  <param name="username" value="YOUR_SINCH_USERNAME"/>\n  <param name="password" value="YOUR_SINCH_PASSWORD"/>\n  <param name="proxy" value="sip.sinch.com"/>\n  <param name="register" value="true"/>\n</gateway>`
    },
    infobip: {
      guide: `1. Log in to Infobip Portal and navigate to Channels > Voice > SIP Trunks.\n2. Create a new SIP trunk and configure your FreeSWITCH node IP.\n3. Set up the XML gateway with your Infobip credentials.`,
      gatewayXml: `<gateway name="infobip">\n  <param name="username" value="YOUR_INFOBIP_USERNAME"/>\n  <param name="password" value="YOUR_INFOBIP_PASSWORD"/>\n  <param name="proxy" value="sip.infobip.com"/>\n  <param name="register" value="true"/>\n</gateway>`
    },
    agora: {
      guide: `1. Log in to Agora Console and enable the SIP Gateway service.\n2. Configure your destination SIP Server (FreeSWITCH Node) and routing rules.\n3. Set up the XML profile using your Agora app ID / credentials.`,
      gatewayXml: `<gateway name="agora">\n  <param name="username" value="YOUR_AGORA_APP_ID"/>\n  <param name="password" value="YOUR_AGORA_TOKEN"/>\n  <param name="proxy" value="sip.agora.io"/>\n  <param name="register" value="false"/>\n</gateway>`
    },
    restcomm: {
      guide: `1. Open your Restcomm instance or cloud account.\n2. Set up a SIP Connection routing to your FreeSWITCH nodes.\n3. Set up gateway XML configuration with credentials.`,
      gatewayXml: `<gateway name="restcomm">\n  <param name="username" value="YOUR_RESTCOMM_USERNAME"/>\n  <param name="password" value="YOUR_RESTCOMM_PASSWORD"/>\n  <param name="proxy" value="sip.restcomm.com"/>\n  <param name="register" value="true"/>\n</gateway>`
    }
  };

  const dialplanXml = `<extension name="ai_voice_agent">\n  <condition field="destination_number" expression="^(\\+?\\d+)$">\n    <action application="answer"/>\n    <action application="playback" data="silence_stream://500"/>\n    <action application="set" data="tts_engine=flite"/>\n    <action application="set" data="tts_voice=slt"/>\n    <!-- Stream audio to voice-engine plugin WebSocket server -->\n    <action application="audio_fork" data="start ws://<your-node-ip>:8089/voice-engine/ws/audio/\${uuid}"/>\n    <action application="park"/>\n  </condition>\n</extension>`;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Custom Engine</h2>
        <p className="text-muted-foreground">Configure AI API keys, active providers, and manage the connected FreeSWITCH nodes and SIP trunks.</p>
      </div>

      {/* Status Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        {[
          { label: "STT", icon: Mic, provider: settings.stt.activeProvider, providers: settings.stt.providers, color: "blue" },
          { label: "LLM", icon: Brain, provider: settings.llm.activeProvider, providers: settings.llm.providers, color: "purple" },
          { label: "TTS", icon: Volume2, provider: settings.tts.activeProvider, providers: settings.tts.providers, color: "orange" },
        ].map(({ label, icon: Icon, provider, providers, color }) => {
          const active = providers[provider];
          return (
            <Card key={label} className={`border-${color}-200 dark:border-${color}-800/50`}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className={`p-2 rounded-lg bg-${color}-100 dark:bg-${color}-950/40`}>
                  <Icon className={`h-5 w-5 text-${color}-600 dark:text-${color}-400`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground capitalize">{active?.name || provider}</p>
                </div>
                <StatusBadge hasKey={active?.hasKey ?? false} />
              </CardContent>
            </Card>
          );
        })}
        <Card className="border-emerald-200 dark:border-emerald-800/50">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-950/40">
              <Server className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">FS Nodes</p>
              <p className="text-xs text-muted-foreground">{nodes.filter(n => n.status === 'online').length} / {nodes.length} Online</p>
            </div>
            <Badge variant="outline" className="border-emerald-500 text-emerald-600">Active</Badge>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-1 mb-4 h-auto p-1 bg-muted/60">
          <TabsTrigger value="speech" className="py-2.5"><Mic className="h-4 w-4 mr-2" />Speech (STT/TTS)</TabsTrigger>
          <TabsTrigger value="llm" className="py-2.5"><Brain className="h-4 w-4 mr-2" />LLM</TabsTrigger>
          <TabsTrigger value="nodes" className="py-2.5"><Server className="h-4 w-4 mr-2" />FreeSWITCH Nodes</TabsTrigger>
          <TabsTrigger value="telephony" className="py-2.5"><Phone className="h-4 w-4 mr-2" />Telephony / SIP</TabsTrigger>
          <TabsTrigger value="storage" className="py-2.5"><Database className="h-4 w-4 mr-2" />Storage</TabsTrigger>
        </TabsList>

        {/* Speech Tab */}
        <TabsContent value="speech" className="space-y-6 mt-4">
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Provider API Keys</CardTitle>
              <CardDescription className="text-xs">Shared between STT and TTS</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <ProviderKeyCard provider="deepgram" label="Deepgram API Key"
                  hasKey={settings.stt.providers.deepgram?.hasKey ?? false}
                  currentMasked={settings.stt.providers.deepgram?.maskedKey ?? ""}
                  onSave={(key) => updateMutation.mutate({ deepgramApiKey: key })}
                  onTest={() => testProvider("deepgram")}
                  isTesting={testingProvider === "deepgram"}
                  testResult={testResults.deepgram ?? null}
                  isDemoMode={isDemoMode} />
                <ProviderKeyCard provider="sarvam" label="Sarvam AI API Key"
                  hasKey={settings.stt.providers.sarvam?.hasKey ?? false}
                  currentMasked={settings.stt.providers.sarvam?.maskedKey ?? ""}
                  onSave={(key) => updateMutation.mutate({ sarvamApiKey: key })}
                  onTest={() => testProvider("sarvam")}
                  isTesting={testingProvider === "sarvam"}
                  testResult={testResults.sarvam ?? null}
                  isDemoMode={isDemoMode} />
{/* <ProviderKeyCard provider="elevenlabs" label="ElevenLabs API Key"
                  hasKey={settings.tts.providers.elevenlabs?.hasKey ?? false}
                  currentMasked={settings.tts.providers.elevenlabs?.maskedKey ?? ""}
                  onSave={(key) => updateMutation.mutate({ elevenlabsApiKey: key })}
                  onTest={() => testProvider("elevenlabs")}
                  isTesting={testingProvider === "elevenlabs"}
                  testResult={testResults.elevenlabs ?? null}
                  isDemoMode={isDemoMode} /> */}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Mic className="h-5 w-5 text-indigo-500" />
                <CardTitle className="text-base">Speech-to-Text (STT)</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-6">
                <div className="space-y-3">
                  <Label className="text-sm font-semibold">Allowed STT Providers</Label>
                  <p className="text-xs text-muted-foreground -mt-2">Select which providers are available for speech-to-text.</p>
                  <div className="grid grid-cols-2 gap-4">
                    {['deepgram', 'sarvam'].map(provider => {
                      const sttAllowed = settings.stt.allowedProviders || ['deepgram'];
                      const isChecked = sttAllowed.includes(provider);
                      return (
                        <div
                          key={provider}
                          className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${isChecked
                            ? "border-indigo-500 bg-indigo-500/10 dark:bg-indigo-500/20"
                            : "border-border hover:border-indigo-400/50 hover:bg-indigo-500/5"
                            }`}
                          onClick={() => {
                            if (isDemoMode) { toast({ title: "Demo Mode", description: "Editing provider settings is disabled in demo mode.", variant: "destructive" }); return; }
                            let newAllowed = [...sttAllowed];
                            if (isChecked) {
                              if (newAllowed.length <= 1) return; // Need at least 1
                              newAllowed = newAllowed.filter(p => p !== provider);
                            } else {
                              newAllowed.push(provider);
                            }
                            updateMutation.mutate({
                              sttAllowedProviders: newAllowed,
                              ...(!newAllowed.includes(settings.stt.activeProvider) && { sttActiveProvider: newAllowed[0] })
                            });
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className="font-semibold">{provider === 'deepgram' ? 'Deepgram' : 'Sarvam AI'}</div>
                            </div>
                            {isChecked && <Check className="h-4 w-4 text-indigo-600" />}
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {provider === 'deepgram' ? 'Fast, accurate STT models' : 'Specialized Indic language models'}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {/* Default Models for each allowed provider */}
                  {(settings.stt.allowedProviders || ['deepgram']).map(provider => {
                    const isDeepgram = provider === 'deepgram';
                    const models = isDeepgram
                      ? [
                        { value: 'nova-2', label: 'Deepgram Nova-2 (General)' },
                        { value: 'nova-2-phonecall', label: 'Deepgram Nova-2 (Phone)' },
                        { value: 'nova-2-medical', label: 'Deepgram Nova-2 (Medical)' },
                        { value: 'nova-3', label: 'Deepgram Nova-3' },
                        { value: 'base', label: 'Deepgram Base' },
                        // { value: 'enhanced', label: 'Deepgram Enhanced' }
                      ]
                      : [
                        { value: 'saaras:v3', label: 'Saaras V3' },
                        { value: 'saarika:v2.5', label: 'Saarika V2.5' },
                        // { value: 'saaras:v3-realtime', label: 'Saaras V3 Realtime' },
                        // { value: 'saarika:v2', label: 'Saarika V2' },
                        // { value: 'saarika:v1', label: 'Saarika V1' },
                        // { value: 'saarika:flash', label: 'Saarika Flash' }
                      ];

                    const allowedModels = isDeepgram ? (settings.stt.deepgramAllowedModels || ['nova-2', 'nova-2-phonecall']) : (settings.stt.sarvamAllowedModels || ['saaras:v3']);

                    return (
                      <div key={`stt-model-${provider}`} className="space-y-4 border rounded-md p-4 bg-muted/20">
                        <div className="space-y-2">
                          <Label>Default Model ({isDeepgram ? 'Deepgram' : 'Sarvam'})</Label>
                          <Select
                            value={isDeepgram ? (settings.stt.deepgramModel || "") : (settings.stt.sarvamModel || "")}
                            onValueChange={(v) => updateMutation.mutate(isDeepgram ? { sttDeepgramModel: v } : { sttSarvamModel: v })}>
                            <SelectTrigger className="w-full"><SelectValue placeholder="Select a model" /></SelectTrigger>
                            <SelectContent>
                              {models.map(m => (
                                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-4 pt-4 border-t">
                          <div>
                            <Label className="text-sm font-semibold">Allowed Models for Agents</Label>
                            <p className="text-xs text-muted-foreground mb-3">Select which models are available to users</p>
                            <div className="flex flex-wrap gap-2">
                              {models.map(m => {
                                const isAllowed = allowedModels.includes(m.value);
                                return (
                                  <Badge
                                    key={m.value}
                                    variant={isAllowed ? "default" : "outline"}
                                    className={`cursor-pointer px-3 py-1.5 transition-all ${isAllowed ? 'bg-indigo-600 hover:bg-indigo-700' : 'text-muted-foreground hover:text-foreground'}`}
                                    onClick={() => {
                                      let newAllowed = [...allowedModels];
                                      if (isAllowed) {
                                        if (newAllowed.length <= 1) return; // need at least 1
                                        newAllowed = newAllowed.filter(x => x !== m.value);
                                      } else {
                                        newAllowed.push(m.value);
                                      }
                                      updateMutation.mutate(
                                        isDeepgram
                                          ? { sttDeepgramAllowedModels: newAllowed }
                                          : { sttSarvamAllowedModels: newAllowed }
                                      );
                                    }}
                                  >
                                    {isAllowed && <Check className="h-3 w-3 mr-1.5 inline-block" />}
                                    {m.label}
                                  </Badge>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Volume2 className="h-5 w-5 text-indigo-500" />
                <CardTitle className="text-base">Text-to-Speech (TTS)</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-6">
                <div className="space-y-3">
                  <Label className="text-sm font-semibold">Allowed TTS Providers</Label>
                  <p className="text-xs text-muted-foreground -mt-2">Select which providers are available for text-to-speech.</p>
                  <div className="grid grid-cols-2 gap-4">
                    {['deepgram', 'sarvam'].map(provider => {
                      const ttsAllowed = settings.tts.allowedProviders || ['deepgram'];
                      const isChecked = ttsAllowed.includes(provider);
                      const getDisplayName = (p: string) => {
                        if (p === 'deepgram') return 'Deepgram';
                        if (p === 'sarvam') return 'Sarvam AI';
                        return 'ElevenLabs';
                      };
                      const getDescription = (p: string) => {
                        if (p === 'deepgram') return 'High quality, low latency voices';
                        if (p === 'sarvam') return 'Expressive Indic voices';
                        return 'Ultra-realistic conversational voices';
                      };
                      return (
                        <div
                          key={provider}
                          className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${isChecked
                            ? "border-indigo-500 bg-indigo-500/10 dark:bg-indigo-500/20"
                            : "border-border hover:border-indigo-400/50 hover:bg-indigo-500/5"
                            }`}
                          onClick={() => {
                            let newAllowed = [...ttsAllowed];
                            if (isChecked) {
                              if (newAllowed.length <= 1) return; // Need at least 1
                              newAllowed = newAllowed.filter(p => p !== provider);
                            } else {
                              newAllowed.push(provider);
                            }
                            updateMutation.mutate({
                              ttsAllowedProviders: newAllowed,
                              ...(!newAllowed.includes(settings.tts.activeProvider) && { ttsActiveProvider: newAllowed[0] })
                            });
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className="font-semibold">{getDisplayName(provider)}</div>
                            </div>
                            {isChecked && <Check className="h-4 w-4 text-indigo-600" />}
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {getDescription(provider)}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {/* Default Models for each allowed provider */}
                  {(settings.tts.allowedProviders || ['deepgram']).map(provider => {
                    const isDeepgram = provider === 'deepgram';
                    const models = isDeepgram
                      ? [
                        { value: 'aura-2', label: 'Deepgram Aura 2' },
                        { value: 'aura', label: 'Deepgram Aura' }
                      ]
                      : [
                        { value: 'bulbul:v3', label: 'Sarvam Bulbul V3' },
                        { value: 'bulbul:v2', label: 'Sarvam Bulbul V2' }
                      ];

                    const allowedModelsRaw = isDeepgram
                      ? (settings.tts.deepgramAllowedModels || ['aura-2', 'aura'])
                      : provider === 'sarvam'
                        ? (settings.tts.sarvamAllowedModels || ['bulbul:v3', 'bulbul:v2'])
                        : (settings.tts.elevenlabsAllowedModels || ['eleven_turbo_v2_5', 'eleven_turbo_v2']);

                    const allowedModels = isDeepgram
                      ? Array.from(new Set(allowedModelsRaw.map(x => x.startsWith('aura-2') ? 'aura-2' : 'aura')))
                      : allowedModelsRaw;

                    const getModelValue = (val: string) => {
                      if (provider === 'deepgram') {
                        if (!val) return "aura-2";
                        if (val.startsWith("aura-2")) return "aura-2";
                        if (val.startsWith("aura")) return "aura";
                        return val;
                      }
                      if (provider === 'sarvam') return val || "bulbul:v3";
                      return val || "eleven_turbo_v2_5";
                    };

                    return (
                      <div key={`tts-model-${provider}`} className="space-y-4 border rounded-md p-4 bg-muted/20">
                        <div className="space-y-2">
                          <Label>Default Voice Model ({provider === 'deepgram' ? 'Deepgram' : provider === 'sarvam' ? 'Sarvam' : 'ElevenLabs'})</Label>
                          <Select
                            value={provider === 'deepgram' ? getModelValue(settings.tts.deepgramModel || "") : provider === 'sarvam' ? (settings.tts.sarvamModel || "") : (settings.tts.elevenlabsModel || "")}
                            onValueChange={(v) => updateMutation.mutate(provider === 'deepgram' ? { ttsDeepgramModel: v } : provider === 'sarvam' ? { ttsSarvamModel: v } : { ttsElevenlabsModel: v })}>
                            <SelectTrigger className="w-full"><SelectValue placeholder="Select a voice model" /></SelectTrigger>
                            <SelectContent>
                              {provider === 'deepgram' ? (
                                <>
                                  <SelectItem value="aura-2">Deepgram Aura 2</SelectItem>
                                  <SelectItem value="aura">Deepgram Aura</SelectItem>
                                </>
                              ) : provider === 'sarvam' ? (
                                <>
                                  <SelectItem value="bulbul:v3">Sarvam Bulbul V3</SelectItem>
                                  <SelectItem value="bulbul:v2">Sarvam Bulbul V2</SelectItem>
                                </>
                              ) : null}
                            </SelectContent>
                          </Select>
                        </div>
                        {/* 
                        <div className="space-y-4 pt-4 border-t">
                          <div>
                            <Label className="text-sm font-semibold">Allowed Models for Agents</Label>
                            <p className="text-xs text-muted-foreground mb-3">Select which models are available to users</p>
                            <div className="flex flex-wrap gap-2">
                              {(provider === 'deepgram' ? (
                                [
                                  { value: 'aura-2', label: 'Deepgram Aura 2' },
                                  { value: 'aura', label: 'Deepgram Aura' }
                                ]
                              ) : provider === 'sarvam' ? (
                                [
                                  { value: 'bulbul:v3', label: 'Sarvam Bulbul V3' },
                                  { value: 'bulbul:v2', label: 'Sarvam Bulbul V2' }
                                ]
                              ) : (
                                [
                                  { value: 'eleven_turbo_v2_5', label: 'Eleven Turbo v2.5' },
                                  { value: 'eleven_turbo_v2', label: 'Eleven Turbo v2' },
                                  { value: 'eleven_multilingual_v2', label: 'Eleven Multilingual v2' }
                                ]
                              )).map(m => {
                                const isAllowed = allowedModels.includes(m.value);
                                return (
                                  <Badge
                                    key={m.value}
                                    variant={isAllowed ? "default" : "outline"}
                                    className={`cursor-pointer px-3 py-1.5 transition-all ${isAllowed ? 'bg-indigo-600 hover:bg-indigo-700' : 'text-muted-foreground hover:text-foreground'}`}
                                    onClick={() => {
                                      if (isDemoMode) { toast({ title: "Demo Mode", description: "Editing model settings is disabled in demo mode.", variant: "destructive" }); return; }
                                      let newAllowed = [...allowedModels];
                                      if (isAllowed) {
                                        if (newAllowed.length <= 1) return; // need at least 1
                                        newAllowed = newAllowed.filter(x => x !== m.value);
                                      } else {
                                        newAllowed.push(m.value);
                                      }
                                      updateMutation.mutate(
                                        provider === 'deepgram'
                                          ? { ttsDeepgramAllowedModels: newAllowed }
                                          : provider === 'sarvam'
                                          ? { ttsSarvamAllowedModels: newAllowed }
                                          : { ttsElevenlabsAllowedModels: newAllowed }
                                      );
                                    }}
                                  >
                                    {isAllowed && <Check className="h-3 w-3 mr-1.5 inline-block" />}
                                    {m.label}
                                  </Badge>
                                );
                              })}
                            </div>
                          </div>
                        </div> */}
                      </div>
                    )
                  })}
                </div>
              </div>
            </CardContent>
          </Card>


        </TabsContent>

        {/* LLM Tab */}
        <TabsContent value="llm" className="space-y-6 mt-4">
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Provider API Keys</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-1 gap-4">
                <ProviderKeyCard provider="openrouter" label="OpenRouter API Key"
                  hasKey={settings.llm.providers.openrouter?.hasKey ?? false}
                  currentMasked={settings.llm.providers.openrouter?.maskedKey ?? ""}
                  onSave={(key) => updateMutation.mutate({ openrouterApiKey: key })}
                  onTest={() => testProvider("openrouter")}
                  isTesting={testingProvider === "openrouter"}
                  testResult={testResults.openrouter ?? null}
                  isDemoMode={isDemoMode} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Brain className="h-5 w-5 text-indigo-500" />
                <CardTitle className="text-base">Language Model Settings</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-6">
                <div className="flex flex-wrap gap-8">
                  <div className="space-y-2 border p-4 rounded-lg bg-muted/20 flex-1 min-w-[280px]">
                    <Label className="text-sm font-semibold">Active LLM Provider</Label>
                    <p className="text-xs text-muted-foreground mb-2">The primary provider for text generation.</p>
                    <Select
                      value={settings.llm.activeProvider}
                      onValueChange={(v) => {
                        if (isDemoMode) { toast({ title: "Demo Mode", description: "Editing provider settings is disabled in demo mode.", variant: "destructive" }); return; }
                        updateMutation.mutate({ llmActiveProvider: v });
                      }}
                      disabled={isDemoMode}
                    >
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="openrouter">OpenRouter</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2 border p-4 rounded-lg bg-muted/20 flex-1 min-w-[280px]">
                    <Label className="text-sm font-semibold">Default Model for OpenRouter</Label>
                    <p className="text-xs text-muted-foreground mb-2">Fallback model if an agent doesn't specify one.</p>
                    <Select
                      value={settings.llm.defaultModel}
                      onValueChange={(v) => {
                        if (isDemoMode) { toast({ title: "Demo Mode", description: "Editing model settings is disabled in demo mode.", variant: "destructive" }); return; }
                        updateMutation.mutate({ llmDefaultModel: v });
                      }}
                      disabled={isDemoMode}
                    >
                      <SelectTrigger className="w-full">
                        {isOrModelsLoading ? (
                          <span className="flex items-center gap-2 text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" /> Loading models...
                          </span>
                        ) : (
                          <SelectValue placeholder="Select a model" />
                        )}
                      </SelectTrigger>
                      <SelectContent className="max-h-[320px]">
                        <div className="px-2 py-1.5 sticky top-0 z-10 bg-popover border-b">
                          <Input
                            placeholder="Search models..."
                            value={orSearch}
                            onChange={(e) => setOrSearch(e.target.value)}
                            className="h-7 text-xs"
                            onKeyDown={(e) => e.stopPropagation()}
                          />
                        </div>
                        {isOrModelsLoading ? (
                          <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground text-xs">
                            <Loader2 className="h-4 w-4 animate-spin" /> Fetching from OpenRouter...
                          </div>
                        ) : orModels.length > 0 ? (
                          orModels
                            .filter((m) =>
                              m.name.toLowerCase().includes(orSearch.toLowerCase()) ||
                              m.id.toLowerCase().includes(orSearch.toLowerCase())
                            )
                            .slice(0, 80)
                            .map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                <div className="flex flex-col py-0.5">
                                  <span className="text-xs font-medium leading-tight">{m.name}</span>
                                  <span className="text-[10px] text-muted-foreground font-mono leading-tight">{m.id}</span>
                                </div>
                              </SelectItem>
                            ))
                        ) : (
                          <>
                            <SelectItem value="openai/gpt-4o-mini">GPT-4o Mini</SelectItem>
                            <SelectItem value="openai/gpt-4o">GPT-4o</SelectItem>
                            <SelectItem value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet</SelectItem>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="mt-2 p-4 rounded-xl border border-indigo-100/80 dark:border-indigo-950/60 bg-indigo-50/20 dark:bg-indigo-950/10 space-y-3">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
                    <Brain className="h-4 w-4" />
                    <span>LLM Cost Tiers & Recommendation Guide</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Choose the best model based on your budget and requirements. Lower latency models are recommended for fast-paced voice conversations. INR rates calculated at ₹95/USD.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="p-3 rounded-lg bg-background border border-indigo-100/50 dark:border-indigo-950/40">
                      <div className="flex items-center justify-between mb-1.5">
                        <Badge variant="outline" className="text-[10px] font-bold text-emerald-600 border-emerald-300 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-950/20">Low Cost</Badge>
                        <div className="text-right">
                          <span className="text-[10px] block font-mono text-muted-foreground font-semibold">~$0.002 - $0.005/min</span>
                          <span className="text-[9px] block font-mono text-emerald-600 font-medium">(₹0.19 - ₹0.48/min)</span>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <strong>Flash & Mini Models</strong> (e.g. <code>gpt-4o-mini</code>, <code>gemini-2.5-flash</code>, <code>gemini-2.0-flash-lite</code>, <code>claude-3-haiku</code>, <code>llama-3.1-8b</code>, <code>deepseek-chat</code>). Ultra-fast response times, highly cost-effective, and ideal for standard high-concurrency conversational flows.
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-background border border-indigo-100/50 dark:border-indigo-950/40">
                      <div className="flex items-center justify-between mb-1.5">
                        <Badge variant="outline" className="text-[10px] font-bold text-amber-600 border-amber-300 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-950/20">Mid Cost</Badge>
                        <div className="text-right">
                          <span className="text-[10px] block font-mono text-muted-foreground font-semibold">~$0.006 - $0.015/min</span>
                          <span className="text-[9px] block font-mono text-amber-600 font-medium">(₹0.57 - ₹1.43/min)</span>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <strong>Standard Models</strong> (e.g. <code>llama-3.1-70b</code>, <code>gemini-2.5-pro</code>, <code>mistral-large</code>, <code>qwen-2.5-72b</code>). Offers balanced intelligence, solid reasoning capability, and moderate pricing suitable for most business logic.
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-background border border-indigo-100/50 dark:border-indigo-950/40">
                      <div className="flex items-center justify-between mb-1.5">
                        <Badge variant="outline" className="text-[10px] font-bold text-violet-600 border-violet-300 dark:border-violet-800 bg-violet-50/30 dark:bg-violet-950/20">Upper Cost</Badge>
                        <div className="text-right">
                          <span className="text-[10px] block font-mono text-muted-foreground font-semibold">~$0.02 - $0.06+/min</span>
                          <span className="text-[9px] block font-mono text-violet-600 font-medium">(₹1.90 - ₹5.70+/min)</span>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <strong>Pro & Sonnet Models</strong> (e.g. <code>gpt-4o</code>, <code>claude-3.5-sonnet</code>, <code>gpt-4-turbo</code>, <code>claude-3-opus</code>). Premium reasoning, advanced tool calling, structured JSON output, and complex multi-step execution.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 pt-2 border-t">
                  <Label className="text-sm font-semibold">Allowed Models (Available for Agents)</Label>
                  <p className="text-xs text-muted-foreground -mt-2">Check the models you want to expose in the Agent creation workflow.</p>
                  <div className="border rounded-md overflow-hidden flex flex-col h-[320px] w-full max-w-[800px] bg-background shadow-sm">
                    <div className="p-2 border-b bg-muted/30">
                      <Input
                        placeholder="Search models (Gemini, OpenRouter...)..."
                        value={orSearch}
                        onChange={(e) => setOrSearch(e.target.value)}
                        className="h-8 text-sm bg-background border-muted"
                      />
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                      {isOrModelsLoading ? (
                        <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground text-sm">
                          <Loader2 className="h-4 w-4 animate-spin" /> Fetching models...
                        </div>
                      ) : (
                        (() => {
                          const staticGeminiModels: Array<{ id: string; name: string }> = [];
                          const allLlmModels = [
                            ...staticGeminiModels,
                            ...orModels
                          ];
                          const filtered = allLlmModels
                            .filter((m) =>
                              m.name.toLowerCase().includes(orSearch.toLowerCase()) ||
                              m.id.toLowerCase().includes(orSearch.toLowerCase())
                            )
                            .sort((a, b) => {
                              const aSelected = settings.llm.allowedModels?.includes(a.id) ? 1 : 0;
                              const bSelected = settings.llm.allowedModels?.includes(b.id) ? 1 : 0;
                              if (aSelected !== bSelected) return bSelected - aSelected;
                              return a.name.localeCompare(b.name);
                            });

                          if (filtered.length === 0) {
                            return <div className="text-center py-4 text-sm text-muted-foreground">No models found.</div>;
                          }

                          return filtered.slice(0, 100).map((m) => {
                            const isSelected = settings.llm.allowedModels?.includes(m.id) ?? false;
                            return (
                              <div
                                key={m.id}
                                className={`flex items-center space-x-3 rounded-md p-2 transition-colors cursor-pointer border border-transparent ${isSelected ? 'bg-indigo-50/50 dark:bg-indigo-950/20 border-indigo-100 dark:border-indigo-900/30' : 'hover:bg-muted/50'}`}
                                onClick={() => {
                                  const currentAllowed = settings.llm.allowedModels || [];
                                  const newAllowed = !isSelected
                                    ? [...currentAllowed, m.id]
                                    : currentAllowed.filter(id => id !== m.id);
                                  updateMutation.mutate({ llmAllowedModels: newAllowed });
                                }}
                              >
                                <Checkbox
                                  id={`model-${m.id}`}
                                  checked={isSelected}
                                  className={isSelected ? "data-[state=checked]:bg-indigo-600 data-[state=checked]:border-indigo-600" : ""}
                                  onCheckedChange={(checked) => {
                                    const currentAllowed = settings.llm.allowedModels || [];
                                    const newAllowed = checked
                                      ? [...currentAllowed, m.id]
                                      : currentAllowed.filter(id => id !== m.id);
                                    updateMutation.mutate({ llmAllowedModels: newAllowed });
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                />
                                <label htmlFor={`model-${m.id}`} className="flex flex-col cursor-pointer flex-1" onClick={(e) => e.stopPropagation()}>
                                  <span className={`text-sm font-medium leading-none ${isSelected ? 'text-indigo-900 dark:text-indigo-300' : ''}`}>{m.name}</span>
                                  <span className="text-[10px] text-muted-foreground font-mono mt-1">{m.id}</span>
                                </label>
                              </div>
                            );
                          });
                        })()
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* FreeSWITCH Nodes Tab */}
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
        {/* Telephony Tab */}
        <TabsContent value="telephony" className="space-y-4 mt-4">
          <Card className="border border-indigo-100 dark:border-indigo-950 bg-indigo-50/20 dark:bg-indigo-950/10">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Info className="h-5 w-5 text-indigo-500" />
                <CardTitle className="text-lg text-indigo-900 dark:text-indigo-200">Decoupled Telephony Architecture</CardTitle>
              </div>
              <CardDescription>
                The Custom Voice Engine decouples telephony from the AI pipeline. Your SIP Providers send/receive calls through <strong>FreeSWITCH</strong> directly. FreeSWITCH streams live audio to this backend over WebSockets.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2 items-center justify-between text-sm py-2 px-3 bg-background rounded-lg border border-border/80">
                <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                  <Badge variant="outline">SIP Provider</Badge>
                  <span>→</span>
                  <Badge variant="secondary">FreeSWITCH Node</Badge>
                  <span>→</span>
                  <Badge className="bg-indigo-600">mod_audio_fork</Badge>
                  <span>→</span>
                  <Badge variant="secondary">WebSocket (Port 8089)</Badge>
                  <span>→</span>
                  <Badge className="bg-indigo-600">AI Voice Engine</Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-4">
              <Card>
                <CardHeader>
                  <div className="flex justify-between items-center">
                    <CardTitle className="text-base">1. Configure Your SIP Provider Gateway</CardTitle>
                    <Select value={selectedSipProvider} onValueChange={setSelectedSipProvider}>
                      <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="twilio">Twilio</SelectItem>
                        <SelectItem value="telnyx">Telnyx</SelectItem>
                        <SelectItem value="plivo">Plivo</SelectItem>
                        <SelectItem value="vonage">Vonage</SelectItem>
                        <SelectItem value="bandwidth">Bandwidth</SelectItem>
                        <SelectItem value="sinch">Sinch</SelectItem>
                        <SelectItem value="infobip">Infobip</SelectItem>
                        <SelectItem value="agora">Agora</SelectItem>
                        <SelectItem value="restcomm">Restcomm</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <CardDescription className="text-xs mt-1 whitespace-pre-line leading-relaxed">
                    {sipTemplates[selectedSipProvider].guide}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex justify-between items-center">
                    <Label className="text-xs font-semibold">
                      FreeSWITCH Gateway configuration file (<span className="font-mono text-indigo-500">conf/sip_profiles/external/{selectedSipProvider}.xml</span>)
                    </Label>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleCopy(sipTemplates[selectedSipProvider].gatewayXml, "gateway")}>
                      {copiedText === "gateway" ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                  <pre className="text-xs bg-muted/60 p-3 rounded-lg overflow-x-auto font-mono max-h-[200px] border">
                    <code>{sipTemplates[selectedSipProvider].gatewayXml}</code>
                  </pre>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">2. Configure Inbound Routing (Dialplan)</CardTitle>
                  <CardDescription>
                    Add this extension xml block inside your FreeSWITCH Dialplan directory (<span className="font-mono text-indigo-500">conf/dialplan/public/*.xml</span>) to bridge inbound SIP trunk calls directly into the AI pipeline.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex justify-between items-center">
                    <Label className="text-xs font-semibold">FreeSWITCH Dialplan snippet (<span className="font-mono text-indigo-500">dialplan.xml</span>)</Label>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleCopy(dialplanXml, "dialplan")}>
                      {copiedText === "dialplan" ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                  <pre className="text-xs bg-muted/60 p-3 rounded-lg overflow-x-auto font-mono max-h-[260px] border">
                    <code>{dialplanXml}</code>
                  </pre>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-4">
              <Card>
                <CardHeader><CardTitle className="text-base">Quick Telephony Checklist</CardTitle></CardHeader>
                <CardContent className="text-xs space-y-3 leading-relaxed text-muted-foreground">
                  {[
                    'Register at least one FreeSWITCH node in the "FreeSWITCH Nodes" tab on this settings page.',
                    'Load the mod_audio_fork module in your FreeSWITCH instance to stream audio over WebSockets.',
                    'Add the Gateway profile configuration from the left to register FreeSWITCH to your provider.',
                    "Map your inbound DID numbers in the dialplan to start audio_fork to this server's WebSocket url.",
                  ].map((text, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <div className="h-5 w-5 shrink-0 rounded-full bg-slate-100 flex items-center justify-center font-bold text-slate-800">{i + 1}</div>
                      <p>{text}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle className="text-base">Why decouplable?</CardTitle></CardHeader>
                <CardContent className="text-xs leading-relaxed text-muted-foreground space-y-2">
                  <p>By keeping the SIP layer on FreeSWITCH, the Custom Voice Engine isn't locked into any specific phone vendor.</p>
                  <p>You can mix-and-match carriers (e.g. use Telnyx for SMS, Twilio for UK numbers, Plivo for Indian DIDs) and load-balance them seamlessly across your FreeSWITCH clusters.</p>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* Storage Tab */}
        <TabsContent value="storage" className="space-y-4 mt-4">
          <StorageSettingsTab />
        </TabsContent>
      </Tabs>

      {/* FreeSWITCH Node Dialog */}
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

      {/* SIP Gateway Dialog */}
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
    </div>
  );
}