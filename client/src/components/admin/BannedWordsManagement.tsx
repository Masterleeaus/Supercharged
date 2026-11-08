import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Pagination } from "@/components/Pagination";
import {
  Loader2,
  ShieldAlert,
  Plus,
  Pencil,
  Trash2,
  AlertTriangle,
  Ban,
  CheckCircle2,
  XCircle,
  Search,
} from "lucide-react";

interface BannedWord {
  id: string;
  word: string;
  category: string;
  severity: string;
  isActive: boolean;
  autoBlock: boolean;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

type Category = "profanity" | "harassment" | "hate_speech" | "threats" | "general";
type Severity = "low" | "medium" | "high" | "critical";

const CATEGORY_OPTIONS: { value: Category; label: string }[] = [
  { value: "harassment", label: "Harassment" },
  { value: "profanity", label: "Profanity" },
  { value: "threats", label: "Threats" },
  { value: "hate_speech", label: "Discrimination" },
  { value: "general", label: "Other" },
];

const SEVERITY_OPTIONS: { value: Severity; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-yellow-500/10 text-yellow-700 border-yellow-500/30",
  medium: "bg-orange-500/10 text-orange-700 border-orange-500/30",
  high: "bg-red-500/10 text-red-700 border-red-500/30",
  critical: "bg-red-700/20 text-red-800 border-red-700/50",
};

const CATEGORY_LABELS: Record<string, string> = {
  harassment: "Harassment",
  profanity: "Profanity",
  threats: "Threats",
  hate_speech: "Discrimination",
  general: "Other",
};

interface FormData {
  word: string;
  category: Category;
  severity: Severity;
  autoBlock: boolean;
  isActive: boolean;
}

const defaultFormData: FormData = {
  word: "",
  category: "general",
  severity: "medium",
  autoBlock: false,
  isActive: true,
};

export default function BannedWordsManagement() {
  const { toast } = useToast();
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectedWord, setSelectedWord] = useState<BannedWord | null>(null);
  const [formData, setFormData] = useState<FormData>(defaultFormData);

  const { data: bannedWords, isLoading } = useQuery<BannedWord[]>({
    queryKey: ["/api/admin/banned-words"],
  });

  const paginatedWords = bannedWords?.slice((page - 1) * pageSize, page * pageSize) || [];
  const totalPages = Math.ceil((bannedWords?.length || 0) / pageSize);

  const createMutation = useMutation({
    mutationFn: async (data: FormData) => {
      return apiRequest("POST", "/api/admin/banned-words", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/banned-words"] });
      toast({ title: t("adminDashboard.bannedWords.toasts.addSuccess") });
      setShowAddDialog(false);
      setFormData(defaultFormData);
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.bannedWords.toasts.addFailed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<FormData> }) => {
      return apiRequest("PATCH", `/api/admin/banned-words/${id}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/banned-words"] });
      toast({ title: t("adminDashboard.bannedWords.toasts.updateSuccess") });
      setShowEditDialog(false);
      setSelectedWord(null);
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.bannedWords.toasts.updateFailed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/admin/banned-words/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/banned-words"] });
      toast({ title: t("adminDashboard.bannedWords.toasts.deleteSuccess") });
      setShowDeleteDialog(false);
      setSelectedWord(null);
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.bannedWords.toasts.deleteFailed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const scanAllCallsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/banned-words/scan-all-calls");
      return res.json();
    },
    onSuccess: (data: { callsScanned: number; violationsFound: number }) => {
      toast({
        title: t("adminDashboard.bannedWords.toasts.scanCompleted"),
        description: t("adminDashboard.bannedWords.toasts.scanCompletedDesc", { scanned: data.callsScanned, violations: data.violationsFound }),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/calls"] });
    },
    onError: (error: any) => {
      toast({
        title: t("adminDashboard.bannedWords.toasts.scanFailed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleAdd = () => {
    setFormData(defaultFormData);
    setShowAddDialog(true);
  };

  const handleEdit = (word: BannedWord) => {
    setSelectedWord(word);
    setFormData({
      word: word.word,
      category: word.category as Category,
      severity: word.severity as Severity,
      autoBlock: word.autoBlock,
      isActive: word.isActive,
    });
    setShowEditDialog(true);
  };

  const handleDelete = (word: BannedWord) => {
    setSelectedWord(word);
    setShowDeleteDialog(true);
  };

  const handleToggleActive = (word: BannedWord) => {
    updateMutation.mutate({
      id: word.id,
      updates: { isActive: !word.isActive },
    });
  };

  const handleToggleAutoBlock = (word: BannedWord) => {
    updateMutation.mutate({
      id: word.id,
      updates: { autoBlock: !word.autoBlock },
    });
  };

  const handleSubmitAdd = () => {
    createMutation.mutate({
      word: formData.word,
      category: formData.category,
      severity: formData.severity,
      autoBlock: formData.autoBlock,
      isActive: formData.isActive,
    });
  };

  const handleSubmitEdit = () => {
    if (!selectedWord) return;
    updateMutation.mutate({
      id: selectedWord.id,
      updates: formData,
    });
  };

  const handleConfirmDelete = () => {
    if (!selectedWord) return;
    deleteMutation.mutate(selectedWord.id);
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5" />
            {t("adminDashboard.bannedWords.title")}
          </CardTitle>
          <CardDescription>
            {t("adminDashboard.bannedWords.description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const activeCount = bannedWords?.filter((w) => w.isActive).length || 0;
  const autoBlockCount = bannedWords?.filter((w) => w.autoBlock).length || 0;
  const criticalCount = bannedWords?.filter((w) => w.severity === "critical").length || 0;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5" />
                {t("adminDashboard.bannedWords.title")}
              </CardTitle>
              <CardDescription>
                {t("adminDashboard.bannedWords.description")}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => scanAllCallsMutation.mutate()}
                disabled={scanAllCallsMutation.isPending}
                data-testid="button-scan-all-calls"
              >
                {scanAllCallsMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Search className="h-4 w-4 mr-2" />
                )}
                {t("adminDashboard.bannedWords.scanAllCalls")}
              </Button>
              <Button onClick={handleAdd} data-testid="button-add-banned-word">
                <Plus className="h-4 w-4 mr-2" />
                {t("adminDashboard.bannedWords.addBannedWord")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="p-4 border rounded-md">
                <div className="text-sm text-muted-foreground">{t("adminDashboard.bannedWords.stats.totalWords")}</div>
                <div className="text-2xl font-bold" data-testid="text-total-count">
                  {bannedWords?.length || 0}
                </div>
              </div>
              <div className="p-4 border rounded-md">
                <div className="text-sm text-muted-foreground">{t("adminDashboard.bannedWords.stats.active")}</div>
                <div className="text-2xl font-bold text-green-600" data-testid="text-active-count">
                  {activeCount}
                </div>
              </div>
              <div className="p-4 border rounded-md">
                <div className="text-sm text-muted-foreground">{t("adminDashboard.bannedWords.stats.autoBlock")}</div>
                <div className="text-2xl font-bold text-orange-600" data-testid="text-autoblock-count">
                  {autoBlockCount}
                </div>
              </div>
              <div className="p-4 border rounded-md">
                <div className="text-sm text-muted-foreground">{t("adminDashboard.bannedWords.stats.critical")}</div>
                <div className="text-2xl font-bold text-red-600" data-testid="text-critical-count">
                  {criticalCount}
                </div>
              </div>
            </div>

            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("adminDashboard.bannedWords.table.word")}</TableHead>
                    <TableHead>{t("adminDashboard.bannedWords.table.category")}</TableHead>
                    <TableHead>{t("adminDashboard.bannedWords.table.severity")}</TableHead>
                    <TableHead>{t("adminDashboard.bannedWords.table.autoBlock")}</TableHead>
                    <TableHead>{t("adminDashboard.bannedWords.table.active")}</TableHead>
                    <TableHead className="text-right">{t("adminDashboard.bannedWords.table.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedWords.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                        {t("adminDashboard.bannedWords.empty")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    (Array.isArray(paginatedWords) ? paginatedWords : []).map((word) => (
                      <TableRow key={word.id} data-testid={`row-banned-word-${word.id}`}>
                        <TableCell className="font-medium" data-testid={`text-word-${word.id}`}>
                          {word.word}
                        </TableCell>
                        <TableCell data-testid={`text-category-${word.id}`}>
                          <Badge variant="outline">
                            {t(`adminDashboard.bannedWords.categories.${word.category}`) || word.category}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={SEVERITY_COLORS[word.severity] || ""}
                            data-testid={`badge-severity-${word.id}`}
                          >
                            {t(`adminDashboard.bannedWords.severities.${word.severity}`)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={word.autoBlock}
                            onCheckedChange={() => handleToggleAutoBlock(word)}
                            disabled={updateMutation.isPending}
                            data-testid={`switch-autoblock-${word.id}`}
                          />
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={word.isActive}
                            onCheckedChange={() => handleToggleActive(word)}
                            disabled={updateMutation.isPending}
                            data-testid={`switch-active-${word.id}`}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleEdit(word)}
                              data-testid={`button-edit-${word.id}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleDelete(word)}
                              data-testid={`button-delete-${word.id}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {totalPages > 1 && (
              <Pagination
                currentPage={page}
                totalPages={totalPages}
                onPageChange={setPage}
                pageSize={pageSize}
                onPageSizeChange={setPageSize}
                totalItems={bannedWords?.length || 0}
              />
            )}

            <div className="text-sm text-muted-foreground space-y-1">
              <p><strong>{t("adminDashboard.bannedWords.note.title")}</strong></p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>{t("adminDashboard.bannedWords.note.activeDesc")}</li>
                <li>{t("adminDashboard.bannedWords.note.autoBlockDesc")}</li>
                <li>{t("adminDashboard.bannedWords.note.criticalDesc")}</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" />
              {t("adminDashboard.bannedWords.addDialog.title")}
            </DialogTitle>
            <DialogDescription>
              {t("adminDashboard.bannedWords.addDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="add-word">{t("adminDashboard.bannedWords.addDialog.wordLabel")}</Label>
              <Input
                id="add-word"
                placeholder={t("adminDashboard.bannedWords.addDialog.wordPlaceholder")}
                value={formData.word}
                onChange={(e) => setFormData({ ...formData, word: e.target.value })}
                data-testid="input-word"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-category">{t("adminDashboard.bannedWords.addDialog.categoryLabel")}</Label>
              <Select
                value={formData.category}
                onValueChange={(value: Category) => setFormData({ ...formData, category: value })}
              >
                <SelectTrigger id="add-category" data-testid="select-category">
                  <SelectValue placeholder={t("adminDashboard.bannedWords.addDialog.categoryPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(`adminDashboard.bannedWords.categories.${option.value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-severity">{t("adminDashboard.bannedWords.addDialog.severityLabel")}</Label>
              <Select
                value={formData.severity}
                onValueChange={(value: Severity) => setFormData({ ...formData, severity: value })}
              >
                <SelectTrigger id="add-severity" data-testid="select-severity">
                  <SelectValue placeholder={t("adminDashboard.bannedWords.addDialog.severityPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <Badge
                        variant="outline"
                        className={SEVERITY_COLORS[option.value]}
                      >
                        {t(`adminDashboard.bannedWords.severities.${option.value}`)}
                      </Badge>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="add-autoblock"
                checked={formData.autoBlock}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, autoBlock: checked as boolean })
                }
                data-testid="checkbox-autoblock"
              />
              <Label htmlFor="add-autoblock" className="text-sm">
                <span className="flex items-center gap-2">
                  <Ban className="h-4 w-4 text-orange-600" />
                  {t("adminDashboard.bannedWords.addDialog.autoBlockLabel")}
                </span>
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowAddDialog(false)}
              data-testid="button-cancel-add"
            >
              {t("adminDashboard.bannedWords.addDialog.cancel")}
            </Button>
            <Button
              onClick={handleSubmitAdd}
              disabled={!formData.word.trim() || createMutation.isPending}
              data-testid="button-submit-add"
            >
              {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("adminDashboard.bannedWords.addDialog.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              {t("adminDashboard.bannedWords.editDialog.title")}
            </DialogTitle>
            <DialogDescription>
              {t("adminDashboard.bannedWords.editDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-word">{t("adminDashboard.bannedWords.editDialog.wordLabel")}</Label>
              <Input
                id="edit-word"
                placeholder={t("adminDashboard.bannedWords.editDialog.wordPlaceholder")}
                value={formData.word}
                onChange={(e) => setFormData({ ...formData, word: e.target.value })}
                data-testid="input-edit-word"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-category">{t("adminDashboard.bannedWords.editDialog.categoryLabel")}</Label>
              <Select
                value={formData.category}
                onValueChange={(value: Category) => setFormData({ ...formData, category: value })}
              >
                <SelectTrigger id="edit-category" data-testid="select-edit-category">
                  <SelectValue placeholder={t("adminDashboard.bannedWords.editDialog.categoryPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(`adminDashboard.bannedWords.categories.${option.value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-severity">{t("adminDashboard.bannedWords.editDialog.severityLabel")}</Label>
              <Select
                value={formData.severity}
                onValueChange={(value: Severity) => setFormData({ ...formData, severity: value })}
              >
                <SelectTrigger id="edit-severity" data-testid="select-edit-severity">
                  <SelectValue placeholder={t("adminDashboard.bannedWords.editDialog.severityPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <Badge
                        variant="outline"
                        className={SEVERITY_COLORS[option.value]}
                      >
                        {t(`adminDashboard.bannedWords.severities.${option.value}`)}
                      </Badge>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="edit-autoblock"
                checked={formData.autoBlock}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, autoBlock: checked as boolean })
                }
                data-testid="checkbox-edit-autoblock"
              />
              <Label htmlFor="edit-autoblock" className="text-sm">
                <span className="flex items-center gap-2">
                  <Ban className="h-4 w-4 text-orange-600" />
                  {t("adminDashboard.bannedWords.editDialog.autoBlockLabel")}
                </span>
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="edit-active"
                checked={formData.isActive}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, isActive: checked as boolean })
                }
                data-testid="checkbox-edit-active"
              />
              <Label htmlFor="edit-active" className="text-sm">
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  {t("adminDashboard.bannedWords.editDialog.activeLabel")}
                </span>
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowEditDialog(false)}
              data-testid="button-cancel-edit"
            >
              {t("adminDashboard.bannedWords.editDialog.cancel")}
            </Button>
            <Button
              onClick={handleSubmitEdit}
              disabled={!formData.word.trim() || updateMutation.isPending}
              data-testid="button-submit-edit"
            >
              {updateMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("adminDashboard.bannedWords.editDialog.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {t("adminDashboard.bannedWords.deleteDialog.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("adminDashboard.bannedWords.deleteDialog.description", { word: selectedWord?.word })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">{t("adminDashboard.bannedWords.deleteDialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("adminDashboard.bannedWords.deleteDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
