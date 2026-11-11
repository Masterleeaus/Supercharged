import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Zap, Settings } from "lucide-react";
import type { TFunction } from "i18next";
import type { LucideProps } from "lucide-react";
import type { Dispatch, SetStateAction, ForwardRefExoticComponent, RefAttributes } from "react";
import { Lead, CategoryCounts } from "@/pages/crm/shared";

export interface CRMPageHeaderProps {
  t: TFunction<"translation", undefined>;
  handleExportCSV: () => Promise<void>;
  setFilterSettingsOpen: Dispatch<SetStateAction<boolean>>;
  aiCategoryFilter: "appointment_booked" | "form_submitted" | "call_transfer" | "need_follow_up" | "hot" | "warm" | "all";
  setAiCategoryFilter: Dispatch<SetStateAction<"appointment_booked" | "form_submitted" | "call_transfer" | "need_follow_up" | "hot" | "warm" | "all">>;
  setListPage: Dispatch<SetStateAction<number>>;
  categoryCounts: CategoryCounts;
  orderedCategories: ({ color: string; id: "appointment_booked"; label: "Appointment Booked"; icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>; } | { color: string; id: "form_submitted"; label: "Form Submitted"; icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>; } | { color: string; id: "call_transfer"; label: "Call Transfer"; icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>; } | { color: string; id: "need_follow_up"; label: "Need Follow Up"; icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>; } | { color: string; id: "hot"; label: "Hot Lead"; icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>; } | { color: string; id: "warm"; label: "Warm Lead"; icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>; })[];
}

export function CRMPageHeader({ t, handleExportCSV, setFilterSettingsOpen, aiCategoryFilter, setAiCategoryFilter, setListPage, categoryCounts, orderedCategories }: CRMPageHeaderProps) {
  return (
    <div className="bg-gradient-to-r from-primary/5 via-primary/3 to-transparent border-b">
        <div className="px-6 py-4 space-y-4">
          {/* Header Row - Title and Actions */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-primary/10">
                <Zap className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-xl font-semibold">{t("crmPage.title")}</h1>
                <p className="text-sm text-muted-foreground">
                  {t("crmPage.description")}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleExportCSV} 
                data-testid="export-leads"
              >
                <Download className="w-4 h-4 mr-1.5" />
                {t("crmPage.export")}
              </Button>

              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => setFilterSettingsOpen(true)} 
                data-testid="open-filter-settings"
              >
                <Settings className="w-4 h-4 mr-1.5" />
                {t("crmPage.settings")}
              </Button>
            </div>
          </div>

          {/* Stats Cards Row - Lead Counts by Category */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3">
            {/* All Leads Card */}
            <Card 
              className={`cursor-pointer transition-all hover-elevate ${aiCategoryFilter === "all" ? "ring-2 ring-primary bg-primary/5" : "bg-card/50"}`}
              onClick={() => {
                setAiCategoryFilter("all");
                setListPage(1);
              }}
              data-testid="filter-all"
            >
              <CardContent className="p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Zap className="w-4 h-4 text-primary" />
                  <span className="text-2xl font-bold">{categoryCounts?.total || 0}</span>
                </div>
                <p className="text-xs text-muted-foreground">{t("crmPage.allLeads")}</p>
              </CardContent>
            </Card>

            {/* Category Cards */}
            {orderedCategories.map((cat) => {
              const Icon = cat.icon;
              const count = categoryCounts?.counts?.[cat.id] || 0;
              const isSelected = aiCategoryFilter === cat.id;
              return (
                <Card 
                  key={cat.id}
                  className={`cursor-pointer transition-all hover-elevate ${isSelected ? "ring-2 ring-primary" : "bg-card/50"}`}
                  onClick={() => {
                    setAiCategoryFilter(cat.id);
                    setListPage(1);
                  }}
                  data-testid={`filter-${cat.id}`}
                  style={isSelected ? { backgroundColor: `${cat.color}15` } : undefined}
                >
                  <CardContent className="p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Icon className="w-4 h-4" style={{ color: cat.color }} />
                      <span className="text-2xl font-bold">{count}</span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{t(`crmPage.categories.${cat.id}`, { defaultValue: cat.label })}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </div>
  );
}
