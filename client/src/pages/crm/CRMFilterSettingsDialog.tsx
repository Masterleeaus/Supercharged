import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Loader2, TrendingUp, Flame, Settings, EyeOff, Eye } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { LeadStage, AI_CATEGORIES, CrmCategoryPreferences } from "@/pages/crm/shared";



// CRM Filter Settings Dialog Component with local state buffering
export function CRMFilterSettingsDialog({
  open,
  onOpenChange,
  categoryPreferences,
  stages,
  onSave,
  isSaving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categoryPreferences?: CrmCategoryPreferences;
  stages: LeadStage[];
  onSave: (settings: {
    hideLeadsWithoutPhone?: boolean;
    hotScoreThreshold?: number;
    warmScoreThreshold?: number;
    hiddenCategories?: string[];
  }) => void;
  isSaving: boolean;
}) {
  // Local state for buffering changes
  const [localSettings, setLocalSettings] = useState({
    hideLeadsWithoutPhone: false,
    hotScoreThreshold: 80,
    warmScoreThreshold: 50,
    hiddenCategories: [] as string[],
  });
    const { t } = useTranslation();

  // Sync local state when dialog opens or preferences change
  useEffect(() => {
    if (open && categoryPreferences) {
      setLocalSettings({
        hideLeadsWithoutPhone: categoryPreferences.hideLeadsWithoutPhone ?? false,
        hotScoreThreshold: categoryPreferences.hotScoreThreshold ?? 80,
        warmScoreThreshold: categoryPreferences.warmScoreThreshold ?? 50,
        hiddenCategories: categoryPreferences.hiddenCategories ?? [],
      });
    }
  }, [open, categoryPreferences]);

  const handleSave = () => {
    onSave(localSettings);
    onOpenChange(false);
  };

  const toggleCategory = (catId: string) => {
    setLocalSettings(prev => ({
      ...prev,
      hiddenCategories: prev.hiddenCategories.includes(catId)
        ? prev.hiddenCategories.filter(id => id !== catId)
        : [...prev.hiddenCategories, catId],
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="filter-settings-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5" />
            {t("crmSettings.title", { defaultValue: "CRM Filter Settings" })}
          </DialogTitle>
          <DialogDescription>
            {t("crmSettings.description", { defaultValue: "Configure how leads are displayed and filtered in your CRM." })}
          </DialogDescription>
        </DialogHeader>
        
        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-6 py-4 pr-4">
            {/* Hide leads without phone toggle */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">{t("crmSettings.hideLeadsWithoutPhone", { defaultValue: "Hide leads without phone" })}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("crmSettings.hideLeadsWithoutPhoneDesc", { defaultValue: "Only show leads that have a valid phone number" })}
                </p>
              </div>
              <Switch
                checked={localSettings.hideLeadsWithoutPhone}
                onCheckedChange={(checked) => {
                  setLocalSettings(prev => ({ ...prev, hideLeadsWithoutPhone: checked }));
                }}
                data-testid="toggle-hide-no-phone"
              />
            </div>

            <Separator />

            {/* Score Thresholds */}
            <div className="space-y-4">
              <Label className="text-sm font-medium">{t("crmSettings.scoreThresholds", { defaultValue: "Lead Score Thresholds" })}</Label>
              <p className="text-xs text-muted-foreground mb-4">
                {t("crmSettings.scoreThresholdsDesc", { defaultValue: "Define score ranges for Hot and Warm lead classifications" })}
              </p>
              
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Flame className="w-4 h-4 text-orange-500" />
                      <span className="text-sm">{t("crmSettings.hotLeadThreshold", { defaultValue: "Hot Lead Threshold" })}</span>
                    </div>
                    <span className="text-sm font-medium">{localSettings.hotScoreThreshold}+</span>
                  </div>
                  <Slider
                    value={[localSettings.hotScoreThreshold]}
                    onValueChange={([value]) => {
                      setLocalSettings(prev => ({ ...prev, hotScoreThreshold: value }));
                    }}
                    min={50}
                    max={100}
                    step={5}
                    className="w-full"
                    data-testid="slider-hot-threshold"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-yellow-500" />
                      <span className="text-sm">{t("crmSettings.warmLeadThreshold", { defaultValue: "Warm Lead Threshold" })}</span>
                    </div>
                    <span className="text-sm font-medium">{localSettings.warmScoreThreshold}+</span>
                  </div>
                  <Slider
                    value={[localSettings.warmScoreThreshold]}
                    onValueChange={([value]) => {
                      setLocalSettings(prev => ({ ...prev, warmScoreThreshold: value }));
                    }}
                    min={20}
                    max={79}
                    step={5}
                    className="w-full"
                    data-testid="slider-warm-threshold"
                  />
                </div>
              </div>
            </div>

            <Separator />

            {/* Hidden Categories */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">{t("crmSettings.visibleCategories", { defaultValue: "Visible Categories" })}</Label>
              <p className="text-xs text-muted-foreground mb-2">
                {t("crmSettings.visibleCategoriesDesc", { defaultValue: "Choose which AI categories to show in the kanban view" })}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {AI_CATEGORIES.map((cat) => {
                  const isHidden = localSettings.hiddenCategories.includes(cat.id);
                  return (
                    <div
                      key={cat.id}
                      className="flex items-center gap-2 p-2 rounded-md border hover-elevate cursor-pointer"
                      onClick={() => toggleCategory(cat.id)}
                      data-testid={`toggle-category-${cat.id}`}
                    >
                      {isHidden ? (
                        <EyeOff className="w-4 h-4 text-muted-foreground" />
                      ) : (
                        <Eye className="w-4 h-4 text-primary" />
                      )}
                      <span className={`text-sm ${isHidden ? 'text-muted-foreground' : ''}`}>
                        {t(`crmPage.categories.${cat.id}`, { defaultValue: cat.label })}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

          </div>
        </ScrollArea>
        
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="cancel-filter-settings">
            {t("common.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button onClick={handleSave} disabled={isSaving} data-testid="save-filter-settings">
            {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            {t("common.save", { defaultValue: "Save Settings" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}