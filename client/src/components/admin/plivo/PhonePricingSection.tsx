import type { AppError } from "@/components/app-error";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Loader2, Phone, Plus, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type { PhonePricing } from "./types";

const addPhonePricingSchema = z.object({
  countryCode: z.string().min(1, "Country code is required").max(3, "Country code too long"),
  countryName: z.string().min(1, "Country name is required").max(100, "Country name too long"),
  purchaseCredits: z.coerce.number().int().min(0),
  monthlyCredits: z.coerce.number().int().min(0),
  kycRequired: z.boolean(),
});

const editPhonePricingSchema = z.object({
  purchaseCredits: z.coerce.number().int().min(0),
  monthlyCredits: z.coerce.number().int().min(0),
  kycRequired: z.boolean(),
  isActive: z.boolean(),
});

type AddPhonePricingFormData = z.infer<typeof addPhonePricingSchema>;
type EditPhonePricingFormData = z.infer<typeof editPhonePricingSchema>;

export function PhonePricingSection() {
  const { toast } = useToast();
  const { t } = useTranslation();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedPricing, setSelectedPricing] = useState<PhonePricing | null>(null);

  const addForm = useForm<AddPhonePricingFormData>({
    resolver: zodResolver(addPhonePricingSchema) as Resolver<AddPhonePricingFormData>,
    defaultValues: {
      countryCode: "",
      countryName: "",
      purchaseCredits: 0,
      monthlyCredits: 0,
      kycRequired: false,
    },
  });

  const editForm = useForm<EditPhonePricingFormData>({
    resolver: zodResolver(editPhonePricingSchema) as Resolver<EditPhonePricingFormData>,
    defaultValues: {
      purchaseCredits: 0,
      monthlyCredits: 0,
      kycRequired: false,
      isActive: true,
    },
  });

  const { data: pricing, isLoading } = useQuery<PhonePricing[]>({
    queryKey: ["/api/plivo/admin/phone-pricing"],
  });

  const addPricing = useMutation({
    mutationFn: async (data: AddPhonePricingFormData) => {
      return apiRequest("POST", "/api/plivo/admin/phone-pricing", {
        countryCode: data.countryCode.toUpperCase(),
        countryName: data.countryName,
        purchaseCredits: parseInt(String(data.purchaseCredits), 10),
        monthlyCredits: parseInt(String(data.monthlyCredits), 10),
        kycRequired: data.kycRequired,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/phone-pricing"] });
      toast({ title: "Phone pricing added successfully" });
      setAddDialogOpen(false);
      addForm.reset();
    },
    onError: (raw_error: Error) => {
      const error = raw_error as AppError;
      toast({
        title: "Failed to add pricing",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const updatePricing = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: EditPhonePricingFormData }) => {
      return apiRequest("PATCH", `/api/plivo/admin/phone-pricing/${id}`, {
        purchaseCredits: parseInt(String(updates.purchaseCredits), 10),
        monthlyCredits: parseInt(String(updates.monthlyCredits), 10),
        kycRequired: updates.kycRequired,
        isActive: updates.isActive,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/phone-pricing"] });
      toast({ title: "Pricing updated successfully" });
      setEditDialogOpen(false);
      setSelectedPricing(null);
    },
    onError: (raw_error: Error) => {
      const error = raw_error as AppError;
      toast({
        title: "Failed to update pricing",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const deletePricing = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/plivo/admin/phone-pricing/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/phone-pricing"] });
      toast({ title: "Pricing deleted successfully" });
      setDeleteDialogOpen(false);
      setSelectedPricing(null);
    },
    onError: (raw_error: Error) => {
      const error = raw_error as AppError;
      toast({
        title: "Failed to delete pricing",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      return apiRequest("PATCH", `/api/plivo/admin/phone-pricing/${id}`, { isActive });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/phone-pricing"] });
      toast({ title: "Pricing status updated" });
    },
    onError: (raw_error: Error) => {
      const error = raw_error as AppError;
      toast({
        title: "Failed to update status",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const openAddDialog = () => {
    addForm.reset({
      countryCode: "",
      countryName: "",
      purchaseCredits: 0,
      monthlyCredits: 0,
      kycRequired: false,
    });
    setAddDialogOpen(true);
  };

  const openEditDialog = (p: PhonePricing) => {
    setSelectedPricing(p);
    editForm.reset({
      purchaseCredits: p.purchaseCredits,
      monthlyCredits: p.monthlyCredits,
      kycRequired: p.kycRequired,
      isActive: p.isActive,
    });
    setEditDialogOpen(true);
  };

  const anyMutationPending = addPricing.isPending || updatePricing.isPending ||
    deletePricing.isPending || toggleActive.isPending;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t("adminDashboard.plivoPricing.title")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("adminDashboard.plivoPricing.description")}
          </p>
        </div>
        <Button
          size="sm"
          onClick={openAddDialog}
          disabled={anyMutationPending}
          data-testid="button-add-pricing"
        >
          <Plus className="h-4 w-4 mr-2" />
          {t("adminDashboard.plivoPricing.addButton")}
        </Button>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("adminDashboard.plivoPricing.table.countryCode")}</TableHead>
              <TableHead>{t("adminDashboard.plivoPricing.table.countryName")}</TableHead>
              <TableHead>{t("adminDashboard.plivoPricing.table.purchaseCredits")}</TableHead>
              <TableHead>{t("adminDashboard.plivoPricing.table.monthlyCredits")}</TableHead>
              <TableHead>{t("adminDashboard.plivoPricing.table.kycRequired")}</TableHead>
              <TableHead>{t("adminDashboard.plivoPricing.table.active")}</TableHead>
              <TableHead className="text-right">{t("adminDashboard.plivoPricing.table.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!pricing || pricing.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  {t("adminDashboard.plivoPricing.table.noPricing")}
                </TableCell>
              </TableRow>
            ) : (
              (Array.isArray(pricing) ? pricing : []).map((p) => (
                <TableRow key={p.id} data-testid={`row-pricing-${p.id}`}>
                  <TableCell className="font-mono" data-testid={`text-country-code-${p.id}`}>
                    {p.countryCode}
                  </TableCell>
                  <TableCell data-testid={`text-country-name-${p.id}`}>
                    {p.countryName}
                  </TableCell>
                  <TableCell data-testid={`text-purchase-credits-${p.id}`}>
                    {p.purchaseCredits}
                  </TableCell>
                  <TableCell data-testid={`text-monthly-credits-${p.id}`}>
                    {p.monthlyCredits}
                  </TableCell>
                  <TableCell>
                    {p.kycRequired ? (
                      <Badge variant="secondary" className="text-yellow-600 border-yellow-600">
                        {t("adminDashboard.plivoPricing.table.required")}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-muted-foreground">
                        {t("adminDashboard.plivoPricing.table.no")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={p.isActive}
                      onCheckedChange={(checked) =>
                        toggleActive.mutate({ id: p.id, isActive: checked })
                      }
                      disabled={toggleActive.isPending || anyMutationPending}
                      data-testid={`switch-pricing-active-${p.id}`}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEditDialog(p)}
                        disabled={anyMutationPending}
                        data-testid={`button-edit-pricing-${p.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setSelectedPricing(p);
                          setDeleteDialogOpen(true);
                        }}
                        disabled={anyMutationPending}
                        data-testid={`button-delete-pricing-${p.id}`}
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

      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("adminDashboard.plivoPricing.addDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("adminDashboard.plivoPricing.addDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <Form {...addForm}>
            <form onSubmit={addForm.handleSubmit((data) => addPricing.mutate(data))} className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={addForm.control}
                  name="countryCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("adminDashboard.plivoPricing.addDialog.countryCode")}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder={t("adminDashboard.plivoPricing.addDialog.countryCodePlaceholder")}
                          maxLength={3}
                          onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                          data-testid="input-country-code"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={addForm.control}
                  name="countryName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("adminDashboard.plivoPricing.addDialog.countryName")}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder={t("adminDashboard.plivoPricing.addDialog.countryNamePlaceholder")}
                          data-testid="input-country-name"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={addForm.control}
                  name="purchaseCredits"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("adminDashboard.plivoPricing.addDialog.purchaseCredits")}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          data-testid="input-purchase-credits"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={addForm.control}
                  name="monthlyCredits"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("adminDashboard.plivoPricing.addDialog.monthlyCredits")}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          data-testid="input-monthly-credits"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={addForm.control}
                name="kycRequired"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="checkbox-kyc-required"
                      />
                    </FormControl>
                    <FormLabel className="text-sm font-normal">
                      {t("adminDashboard.plivoPricing.addDialog.kycRequired")}
                    </FormLabel>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAddDialogOpen(false)}>
                  {t("adminDashboard.plivoPricing.addDialog.cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={addPricing.isPending}
                  data-testid="button-save-pricing"
                >
                  {addPricing.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {t("adminDashboard.plivoPricing.addDialog.addPricing")}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("adminDashboard.plivoPricing.editDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("adminDashboard.plivoPricing.editDialog.description", {
                countryName: selectedPricing?.countryName,
                countryCode: selectedPricing?.countryCode
              })}
            </DialogDescription>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit((data) => {
              if (selectedPricing) {
                updatePricing.mutate({ id: selectedPricing.id, updates: data });
              }
            })} className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t("adminDashboard.plivoPricing.editDialog.countryCode")}</Label>
                  <Input
                    value={selectedPricing?.countryCode || ""}
                    disabled
                    className="bg-muted font-mono"
                    data-testid="input-edit-country-code"
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t("adminDashboard.plivoPricing.editDialog.countryName")}</Label>
                  <Input
                    value={selectedPricing?.countryName || ""}
                    disabled
                    className="bg-muted"
                    data-testid="input-edit-country-name"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={editForm.control}
                  name="purchaseCredits"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("adminDashboard.plivoPricing.editDialog.purchaseCredits")}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          data-testid="input-edit-purchase-credits"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="monthlyCredits"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("adminDashboard.plivoPricing.editDialog.monthlyCredits")}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          data-testid="input-edit-monthly-credits"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={editForm.control}
                name="kycRequired"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="checkbox-edit-kyc-required"
                      />
                    </FormControl>
                    <FormLabel className="text-sm font-normal">
                      {t("adminDashboard.plivoPricing.editDialog.kycRequired")}
                    </FormLabel>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="checkbox-edit-is-active"
                      />
                    </FormControl>
                    <FormLabel className="text-sm font-normal">
                      {t("adminDashboard.plivoPricing.editDialog.active")}
                    </FormLabel>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditDialogOpen(false)}>
                  {t("adminDashboard.plivoPricing.editDialog.cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={updatePricing.isPending}
                  data-testid="button-update-pricing"
                >
                  {updatePricing.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {t("adminDashboard.plivoPricing.editDialog.update")}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("adminDashboard.plivoPricing.deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("adminDashboard.plivoPricing.deleteDialog.description", { countryName: selectedPricing?.countryName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePricing.isPending}>
              {t("adminDashboard.plivoPricing.deleteDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (selectedPricing) {
                  deletePricing.mutate(selectedPricing.id);
                }
              }}
              disabled={deletePricing.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-pricing"
            >
              {deletePricing.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("adminDashboard.plivoPricing.deleteDialog.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
