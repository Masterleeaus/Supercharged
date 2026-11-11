import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Phone, Calendar, ArrowRightLeft, PhoneForwarded, Play, Pause, Plus, MessageSquare, ClipboardCheck, PhoneCall, Zap, History, Tag } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Lead, LeadNote, LeadActivity, getStageTheme, ScoreIndicator, SentimentIcon } from "@/pages/crm/shared";



export function LeadDetailModal({ lead, open, onClose, stageColor }: { lead: Lead | null; open: boolean; onClose: () => void; stageColor?: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClientRef = useQueryClient();
  const [noteText, setNoteText] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTab, setActiveTab] = useState("notes");

  useEffect(() => {
    if (!open && lead?.id) {
      const audio = document.getElementById(`audio-${lead.id}`) as HTMLAudioElement;
      if (audio) {
        audio.pause();
      }
      setIsPlaying(false);
    }
  }, [open, lead?.id]);

  useEffect(() => {
    return () => {
      if (lead?.id) {
        const audio = document.getElementById(`audio-${lead.id}`) as HTMLAudioElement;
        if (audio) {
          audio.pause();
        }
      }
    };
  }, [lead?.id]);

  const displayName = lead ? [lead.firstName, lead.lastName].filter(Boolean).join(" ") || t("crmPage.unknown") : "";

  const notesQueryKey = `/api/crm/leads/${lead?.id}/notes`;
  const { data: notes = [], isLoading: notesLoading } = useQuery<LeadNote[]>({
    queryKey: [notesQueryKey],
    enabled: !!lead?.id && open,
  });

  const activitiesQueryKey = `/api/crm/leads/${lead?.id}/activities`;
  const { data: activities = [], isLoading: activitiesLoading } = useQuery<LeadActivity[]>({
    queryKey: [activitiesQueryKey],
    enabled: !!lead?.id && open,
  });

  const addNoteMutation = useMutation({
    mutationFn: async (content: string) => {
      return apiRequest("POST", `/api/crm/leads/${lead?.id}/notes`, { content });
    },
    onSuccess: () => {
      toast({ title: t("crmPage.addNote") });
      setNoteText("");
      queryClientRef.invalidateQueries({ queryKey: [notesQueryKey] });
      queryClientRef.invalidateQueries({ queryKey: [activitiesQueryKey] });
    },
    onError: (error: any) => {
      toast({ title: t("common.error"), description: error.message, variant: "destructive" });
    },
  });

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'call': return <Phone className="w-3 h-3" />;
      case 'note': return <MessageSquare className="w-3 h-3" />;
      case 'stage_change': return <ArrowRightLeft className="w-3 h-3" />;
      case 'tag_added': case 'tag_removed': return <Tag className="w-3 h-3" />;
      case 'created': return <Plus className="w-3 h-3" />;
      case 'transfer': return <PhoneForwarded className="w-3 h-3" />;
      case 'appointment': return <Calendar className="w-3 h-3" />;
      default: return <History className="w-3 h-3" />;
    }
  };

  if (!lead) return null;

  const theme = getStageTheme(lead.stage, stageColor);

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="lead-detail-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <ScoreIndicator score={lead.leadScore} />
            <div>
              <span className="text-lg">{displayName}</span>
              <div className="flex items-center gap-2 mt-1">
                <Badge className={theme.badgeBg}>{lead.stage}</Badge>
                {lead.sentiment && (
                  <Badge variant="outline" className="flex items-center gap-1">
                    <SentimentIcon sentiment={lead.sentiment} />
                    <span className="capitalize">{t(`sentiment.${lead.sentiment}`, { defaultValue: lead.sentiment })}</span>
                  </Badge>
                )}
              </div>
            </div>
          </DialogTitle>
          <DialogDescription>
            {t("crmPage.leadDetails")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">{t("crmPage.phone")}</p>
              <p className="font-mono" data-testid="lead-detail-phone">{lead.phone}</p>
            </div>
            {lead.email && (
              <div>
                <p className="text-sm text-muted-foreground">{t("crmPage.email")}</p>
                <p data-testid="lead-detail-email">{lead.email}</p>
              </div>
            )}
            <div>
              <p className="text-sm text-muted-foreground">{t("crmPage.source")}</p>
              <Badge variant="outline" className="flex items-center gap-1 w-fit">
                {lead.sourceType === "campaign" ? <Zap className="w-3 h-3" /> : <PhoneCall className="w-3 h-3" />}
                {lead.sourceType === "campaign" ? t("crmPage.campaigns") : t("crmPage.incoming")}
              </Badge>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t("crmPage.created")}</p>
              <p className="text-sm">{new Date(lead.createdAt).toLocaleDateString()}</p>
            </div>
          </div>

          <Separator />

          <div className="flex flex-wrap gap-2">
            {lead.hasAppointment && (
              <Badge className="bg-blue-500 text-white flex items-center gap-1">
                <Calendar className="w-3 h-3" /> {t("crmPage.appointmentBooked")}
              </Badge>
            )}
            {lead.hasFormSubmission && (
              <Badge className="bg-purple-500 text-white flex items-center gap-1">
                <ClipboardCheck className="w-3 h-3" /> {t("crmPage.formSubmitted")}
              </Badge>
            )}
            {lead.hasTransfer && (
              <Badge className="bg-violet-500 text-white flex items-center gap-1">
                <PhoneForwarded className="w-3 h-3" /> {t("crmPage.transferred")}
              </Badge>
            )}
            {lead.hasCallback && (
              <Badge className="bg-amber-500 text-white flex items-center gap-1">
                <PhoneCall className="w-3 h-3" /> {t("crmPage.callbackScheduled")}
              </Badge>
            )}
          </div>

          {lead.recordingUrl && (
            <div>
              <p className="text-sm font-medium mb-2">{t("crmPage.recording")}</p>
              <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    const audio = document.getElementById(`audio-${lead.id}`) as HTMLAudioElement;
                    if (audio) {
                      if (isPlaying) {
                        audio.pause();
                      } else {
                        audio.play();
                      }
                      setIsPlaying(!isPlaying);
                    }
                  }}
                  data-testid="play-recording-button"
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </Button>
                <audio id={`audio-${lead.id}`} src={lead.recordingUrl} onEnded={() => setIsPlaying(false)} className="hidden" />
                <span className="text-sm text-muted-foreground">{t("crmPage.callRecording")}</span>
              </div>
            </div>
          )}

          {lead.aiSummary && (
            <div>
              <p className="text-sm font-medium mb-2">{t("crmPage.aiSummary")}</p>
              <p className="text-sm text-muted-foreground bg-muted p-3 rounded-lg" data-testid="lead-ai-summary">{lead.aiSummary}</p>
            </div>
          )}

          {lead.transcript && (
            <div>
              <p className="text-sm font-medium mb-2">{t("crmPage.transcript")}</p>
              <ScrollArea className="h-48 bg-muted p-3 rounded-lg">
                <pre className="text-xs whitespace-pre-wrap font-sans" data-testid="lead-transcript">{lead.transcript}</pre>
              </ScrollArea>
            </div>
          )}

          <Separator />

          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="w-full">
              <TabsTrigger value="notes" className="flex-1" data-testid="tab-notes">
                <MessageSquare className="w-4 h-4 mr-2" />
                {t("crmPage.notes")} ({notes.length})
              </TabsTrigger>
              <TabsTrigger value="activity" className="flex-1" data-testid="tab-activity">
                <History className="w-4 h-4 mr-2" />
                {t("crmPage.activity")} ({activities.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="notes" className="mt-4" data-testid="notes-section">
              {notesLoading ? (
                <div className="flex items-center justify-center py-4" data-testid="notes-loading">
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                </div>
              ) : notes.length > 0 ? (
                <div className="space-y-3 mb-4" data-testid="notes-list">
                  {notes.map((note, index) => (
                    <div key={note.id} className="p-3 bg-muted rounded-lg" data-testid={`note-item-${index}`}>
                      <p className="text-sm" data-testid={`note-content-${index}`}>{note.content}</p>
                      <p className="text-xs text-muted-foreground mt-2" data-testid={`note-date-${index}`}>
                        {new Date(note.createdAt).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground mb-4" data-testid="notes-empty">{t("crmPage.noNotes")}</p>
              )}

              <div className="space-y-2">
                <Textarea 
                  placeholder={t("crmPage.addNotePlaceholder")}
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  className="min-h-[80px]"
                  data-testid="lead-note-input"
                />
                <Button 
                  onClick={() => noteText.trim() && addNoteMutation.mutate(noteText.trim())}
                  disabled={!noteText.trim() || addNoteMutation.isPending}
                  data-testid="add-note-button"
                >
                  {addNoteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  {t("crmPage.addNote")}
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="activity" className="mt-4" data-testid="activity-section">
              {activitiesLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                </div>
              ) : activities.length > 0 ? (
                <ScrollArea className="h-64">
                  <div className="space-y-3" data-testid="activity-list">
                    {activities.map((activity, index) => (
                      <div key={activity.id} className="flex gap-3 p-3 bg-muted rounded-lg" data-testid={`activity-item-${index}`}>
                        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-background shrink-0">
                          {getActivityIcon(activity.activityType)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">{activity.title}</p>
                          {activity.description && (
                            <p className="text-xs text-muted-foreground mt-1">{activity.description}</p>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">
                            {new Date(activity.createdAt).toLocaleString()}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <p className="text-sm text-muted-foreground">{t("crmPage.noActivity")}</p>
              )}
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="close-lead-modal">{t("crmPage.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}