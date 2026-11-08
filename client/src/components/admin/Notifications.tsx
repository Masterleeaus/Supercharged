/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";
import {
  Send,
  Loader2,
  Bell,
  MessageSquare,
  AlertCircle,
  Info,
  CheckCircle,
  AlertTriangle,
  Megaphone,
  Sparkles,
  Gift,
  PartyPopper,
  Calendar as CalendarIcon,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

interface IconOption {
  value: string;
  label: string;
  icon: LucideIcon;
}

const ICON_OPTIONS: IconOption[] = [
  { value: "bell", label: "icons.bell", icon: Bell },
  { value: "alert-circle", label: "icons.alert", icon: AlertCircle },
  { value: "info", label: "icons.info", icon: Info },
  { value: "check-circle", label: "icons.success", icon: CheckCircle },
  { value: "alert-triangle", label: "icons.warning", icon: AlertTriangle },
  { value: "megaphone", label: "icons.megaphone", icon: Megaphone },
  { value: "sparkles", label: "icons.sparkles", icon: Sparkles },
  { value: "gift", label: "icons.gift", icon: Gift },
  { value: "party-popper", label: "icons.celebration", icon: PartyPopper },
];

const DISPLAY_TYPES = [
  { value: "bell", label: "displayTypes.bell" },
  { value: "banner", label: "displayTypes.banner" },
  { value: "both", label: "displayTypes.both" },
];

export default function Notifications() {
  const { toast } = useToast();
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [icon, setIcon] = useState("bell");
  const [link, setLink] = useState("");
  const [displayType, setDisplayType] = useState<"bell" | "banner" | "both">("bell");
  const [priority, setPriority] = useState(5);
  const [dismissible, setDismissible] = useState(true);
  const [expiresAt, setExpiresAt] = useState<Date | undefined>(undefined);

  const broadcastMutation = useMutation({
    mutationFn: async (data: {
      title: string;
      message: string;
      icon?: string;
      link?: string;
      displayType?: "bell" | "banner" | "both";
      priority?: number;
      dismissible?: boolean;
      expiresAt?: string | null;
    }) => {
      return apiRequest("POST", "/api/admin/notifications/broadcast", data);
    },
    onSuccess: (data: any) => {
      toast({
        title: t("adminDashboard.notifications.toast.sentSuccess"),
        description: t("adminDashboard.notifications.toast.sentToUsers", { count: data.recipientCount || 0 }),
      });
      resetForm();
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.notifications.toast.sendFailed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setTitle("");
    setMessage("");
    setIcon("bell");
    setLink("");
    setDisplayType("bell");
    setPriority(5);
    setDismissible(true);
    setExpiresAt(undefined);
  };

  const handleSend = () => {
    if (!title.trim() || !message.trim()) {
      toast({
        title: t("adminDashboard.notifications.toast.validationError"),
        description: t("adminDashboard.notifications.toast.provideTitleMessage"),
        variant: "destructive",
      });
      return;
    }

    broadcastMutation.mutate({
      title,
      message,
      icon,
      link: link.trim() || undefined,
      displayType,
      priority,
      dismissible,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    });
  };

  const getIconComponent = (iconValue: string): LucideIcon => {
    const found = ICON_OPTIONS.find(opt => opt.value === iconValue);
    return found ? found.icon : Bell;
  };

  const SelectedIcon = getIconComponent(icon);

  return (
    <div className="space-y-6">
      <Alert>
        <Bell className="h-4 w-4" />
        <AlertDescription>
          {t("adminDashboard.notifications.inAppOnly")}
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5" />
            {t("adminDashboard.notifications.createBroadcast.title")}
          </CardTitle>
          <CardDescription>
            {t("adminDashboard.notifications.createBroadcast.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="title">{t("adminDashboard.notifications.createBroadcast.titleLabel")}</Label>
              <Input
                id="title"
                placeholder={t("adminDashboard.notifications.createBroadcast.titlePlaceholder")}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={broadcastMutation.isPending}
                data-testid="input-notification-title"
              />
            </div>

            <div className="space-y-2">
              <Label>{t("adminDashboard.notifications.createBroadcast.iconLabel")}</Label>
              <Select value={icon} onValueChange={setIcon} disabled={broadcastMutation.isPending}>
                <SelectTrigger data-testid="select-notification-icon">
                  <SelectValue>
                    <div className="flex items-center gap-2">
                      <SelectedIcon className="h-4 w-4" />
                      <span>{t(`adminDashboard.notifications.${ICON_OPTIONS.find(opt => opt.value === icon)?.label || "icons.bell"}`)}</span>
                    </div>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {ICON_OPTIONS.map((opt) => {
                    const IconComp = opt.icon;
                    return (
                      <SelectItem key={opt.value} value={opt.value}>
                        <div className="flex items-center gap-2">
                          <IconComp className="h-4 w-4" />
                          <span>{t(`adminDashboard.notifications.${opt.label}`)}</span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="message">{t("adminDashboard.notifications.createBroadcast.messageLabel")}</Label>
            <Textarea
              id="message"
              placeholder={t("adminDashboard.notifications.createBroadcast.messagePlaceholder")}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={broadcastMutation.isPending}
              rows={4}
              data-testid="textarea-notification-message"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="link" className="flex items-center gap-2">
                <ExternalLink className="h-4 w-4" />
                {t("adminDashboard.notifications.createBroadcast.linkLabel")}
              </Label>
              <Input
                id="link"
                placeholder={t("adminDashboard.notifications.createBroadcast.linkPlaceholder")}
                value={link}
                onChange={(e) => setLink(e.target.value)}
                disabled={broadcastMutation.isPending}
                data-testid="input-notification-link"
              />
              <p className="text-xs text-muted-foreground">
                {t("adminDashboard.notifications.createBroadcast.linkHint")}
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t("adminDashboard.notifications.createBroadcast.displayTypeLabel")}</Label>
              <Select value={displayType} onValueChange={(val) => setDisplayType(val as "bell" | "banner" | "both")} disabled={broadcastMutation.isPending}>
                <SelectTrigger data-testid="select-display-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DISPLAY_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {t(`adminDashboard.notifications.${type.label}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t("adminDashboard.notifications.createBroadcast.priorityLabel")}</Label>
              <Select value={priority.toString()} onValueChange={(val) => setPriority(parseInt(val))} disabled={broadcastMutation.isPending}>
                <SelectTrigger data-testid="select-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((p) => (
                    <SelectItem key={p} value={p.toString()}>
                      {p} - {p <= 3 ? t("adminDashboard.notifications.priorities.low") : p <= 6 ? t("adminDashboard.notifications.priorities.medium") : t("adminDashboard.notifications.priorities.high")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>{t("adminDashboard.notifications.createBroadcast.expiryLabel")}</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal",
                      !expiresAt && "text-muted-foreground"
                    )}
                    data-testid="button-expiry-date"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {expiresAt ? format(expiresAt, "PPP") : t("adminDashboard.notifications.createBroadcast.expiryPlaceholder")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={expiresAt}
                    onSelect={setExpiresAt}
                    disabled={(date) => date < new Date()}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              {expiresAt && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExpiresAt(undefined)}
                  className="text-xs"
                  data-testid="button-clear-expiry"
                >
                  {t("common.clear")}
                </Button>
              )}
            </div>

            <div className="space-y-2">
              <Label>{t("adminDashboard.notifications.createBroadcast.dismissibleLabel")}</Label>
              <div className="flex items-center justify-between rounded-lg border p-3 h-[40px]">
                <span className="text-sm">
                  {dismissible ? t("common.yes") : t("common.no")}
                </span>
                <Switch
                  checked={dismissible}
                  onCheckedChange={setDismissible}
                  disabled={broadcastMutation.isPending}
                  data-testid="switch-dismissible"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-4 border-t">
            <p className="text-sm text-muted-foreground">
              {t("adminDashboard.notifications.createBroadcast.sendToAllUsers")}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={resetForm}
                disabled={broadcastMutation.isPending}
                data-testid="button-reset-form"
              >
                {t("common.clear")}
              </Button>
              <Button
                onClick={handleSend}
                disabled={broadcastMutation.isPending || !title.trim() || !message.trim()}
                data-testid="button-send-notification"
              >
                {broadcastMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {t("adminDashboard.notifications.createBroadcast.sending")}
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    {t("adminDashboard.notifications.createBroadcast.sendButton")}
                  </>
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
