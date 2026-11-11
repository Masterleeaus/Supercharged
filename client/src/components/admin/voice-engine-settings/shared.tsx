
/**
 * Admin Voice Engine Settings
 * Manages API keys, active providers, FreeSWITCH nodes, and SIP trunking templates.
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, XCircle, Key, Save, TestTube, Eye, EyeOff, HardDrive, Cloud } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDemoMode } from "@/components/DemoModeBanner";

export interface ProviderInfo {
  name: string;
  hasKey: boolean;
  maskedKey: string;
}

export interface ProviderSettings {
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

export interface FreeSwitchNode {
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

export interface SipGateway {
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

export function StatusBadge({ hasKey }: { hasKey: boolean }) {
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

export function NodeStatusBadge({ status }: { status: string }) {
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

export function ProviderKeyCard({
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

export type StorageProvider = 'local' | 's3' | 'gcs' | 'do_spaces' | 'wasabi';

export interface StorageConfig {
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

export const STORAGE_PROVIDERS: { value: StorageProvider; label: string; icon: React.ReactNode; description: string }[] = [
  { value: 'local', label: 'Local Storage', icon: <HardDrive className="h-5 w-5" />, description: 'Store recordings on the server disk. Simple and free, but not recommended for production.' },
  { value: 's3', label: 'AWS S3', icon: <Cloud className="h-5 w-5" />, description: 'Store recordings in Amazon S3. Highly scalable and durable.' },
  { value: 'gcs', label: 'Google Cloud Storage', icon: <Cloud className="h-5 w-5" />, description: 'Store recordings in Google Cloud Storage (GCS).' },
  { value: 'do_spaces', label: 'DigitalOcean Spaces', icon: <Cloud className="h-5 w-5" />, description: 'S3-compatible object storage from DigitalOcean.' },
  { value: 'wasabi', label: 'Wasabi', icon: <Cloud className="h-5 w-5" />, description: 'Low-cost S3-compatible hot cloud storage.' },
];

export function StorageSettingsTab() {
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