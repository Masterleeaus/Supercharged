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
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Loader2, Plus, Pencil, Trash2, CheckCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type { PlivoCredential } from "./types";

const addPlivoCredentialSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  authId: z.string().min(1, "Auth ID is required"),
  authToken: z.string().min(1, "Auth Token is required"),
  isPrimary: z.boolean(),
});

const editPlivoCredentialSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  isPrimary: z.boolean(),
});

type AddPlivoCredentialFormData = z.infer<typeof addPlivoCredentialSchema>;
type EditPlivoCredentialFormData = z.infer<typeof editPlivoCredentialSchema>;

export function PlivoCredentialsSection() {
  const { toast } = useToast();
  const { t } = useTranslation();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedCredential, setSelectedCredential] = useState<PlivoCredential | null>(null);

  const addForm = useForm<AddPlivoCredentialFormData>({
    resolver: zodResolver(addPlivoCredentialSchema),
    defaultValues: {
      name: "",
      authId: "",
      authToken: "",
      isPrimary: false,
    },
  });

  const editForm = useForm<EditPlivoCredentialFormData>({
    resolver: zodResolver(editPlivoCredentialSchema),
    defaultValues: {
      name: "",
      isPrimary: false,
    },
  });

  const { data: credentials, isLoading } = useQuery<PlivoCredential[]>({
    queryKey: ["/api/plivo/admin/credentials"],
  });

  const addCredential = useMutation({
    mutationFn: async (data: AddPlivoCredentialFormData) => {
      return apiRequest("POST", "/api/plivo/admin/credentials", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/credentials"] });
      toast({ title: "Plivo credential added successfully" });
      setAddDialogOpen(false);
      addForm.reset();
    },
    onError: (raw_error: Error) => {
      const error = raw_error as AppError;
      toast({
        title: "Failed to add credential",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const updateCredential = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<PlivoCredential> }) => {
      return apiRequest("PATCH", `/api/plivo/admin/credentials/${id}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/credentials"] });
      toast({ title: "Credential updated successfully" });
      setEditDialogOpen(false);
      setSelectedCredential(null);
    },
    onError: (raw_error: Error) => {
      const error = raw_error as AppError;
      toast({
        title: "Failed to update credential",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const deleteCredential = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/plivo/admin/credentials/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/credentials"] });
      toast({ title: "Credential deleted successfully" });
      setDeleteDialogOpen(false);
      setSelectedCredential(null);
    },
    onError: (raw_error: Error) => {
      const error = raw_error as AppError;
      toast({
        title: "Failed to delete credential",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      return apiRequest("PATCH", `/api/plivo/admin/credentials/${id}`, { isActive });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/credentials"] });
      toast({ title: "Credential status updated" });
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

  const maskAuthId = (authId: string) => {
    if (!authId || authId.length < 8) return authId;
    return authId.slice(0, 4) + "..." + authId.slice(-4);
  };

  const openAddDialog = () => {
    addForm.reset({
      name: "",
      authId: "",
      authToken: "",
      isPrimary: false,
    });
    setAddDialogOpen(true);
  };

  const openEditDialog = (cred: PlivoCredential) => {
    setSelectedCredential(cred);
    editForm.reset({
      name: cred.name,
      isPrimary: cred.isPrimary,
    });
    setEditDialogOpen(true);
  };

  const anyMutationPending = addCredential.isPending || updateCredential.isPending ||
    deleteCredential.isPending || toggleActive.isPending;

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
          <h3 className="text-lg font-semibold">{t("adminDashboard.plivoCredentials.title")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("adminDashboard.plivoCredentials.description")}
          </p>
        </div>
        <Button
          size="sm"
          onClick={openAddDialog}
          disabled={anyMutationPending}
          data-testid="button-add-plivo-credential"
        >
          <Plus className="h-4 w-4 mr-2" />
          {t("adminDashboard.plivoCredentials.addButton")}
        </Button>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("adminDashboard.plivoCredentials.table.name")}</TableHead>
              <TableHead>{t("adminDashboard.plivoCredentials.table.authId")}</TableHead>
              <TableHead>{t("adminDashboard.plivoCredentials.table.primary")}</TableHead>
              <TableHead>{t("adminDashboard.plivoCredentials.table.status")}</TableHead>
              <TableHead>{t("adminDashboard.plivoCredentials.table.active")}</TableHead>
              <TableHead className="text-right">{t("adminDashboard.plivoCredentials.table.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!credentials || credentials.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  {t("adminDashboard.plivoCredentials.table.noCredentials")}
                </TableCell>
              </TableRow>
            ) : (
              (Array.isArray(credentials) ? credentials : []).map((cred) => (
                <TableRow key={cred.id} data-testid={`row-plivo-${cred.id}`}>
                  <TableCell className="font-medium" data-testid={`text-plivo-name-${cred.id}`}>
                    {cred.name}
                  </TableCell>
                  <TableCell className="font-mono text-sm" data-testid={`text-auth-id-${cred.id}`}>
                    {maskAuthId(cred.authId)}
                  </TableCell>
                  <TableCell>
                    {cred.isPrimary && (
                      <Badge variant="secondary" className="text-blue-600 border-blue-600">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        {t("adminDashboard.plivoCredentials.table.primaryBadge")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {cred.isActive ? (
                      <Badge variant="secondary" className="text-green-600 border-green-600">
                        {t("adminDashboard.plivoCredentials.table.activeStatus")}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-muted-foreground">
                        {t("adminDashboard.plivoCredentials.table.inactiveStatus")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={cred.isActive}
                      onCheckedChange={(checked) =>
                        toggleActive.mutate({ id: cred.id, isActive: checked })
                      }
                      disabled={toggleActive.isPending || anyMutationPending}
                      data-testid={`switch-plivo-active-${cred.id}`}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEditDialog(cred)}
                        disabled={anyMutationPending}
                        data-testid={`button-edit-plivo-${cred.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setSelectedCredential(cred);
                          setDeleteDialogOpen(true);
                        }}
                        disabled={anyMutationPending}
                        data-testid={`button-delete-plivo-${cred.id}`}
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
            <DialogTitle>{t("adminDashboard.plivoCredentials.addDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("adminDashboard.plivoCredentials.addDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <Form {...addForm}>
            <form onSubmit={addForm.handleSubmit((data) => addCredential.mutate(data))} className="space-y-4 py-4">
              <FormField
                control={addForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("adminDashboard.plivoCredentials.addDialog.name")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder={t("adminDashboard.plivoCredentials.addDialog.namePlaceholder")}
                        data-testid="input-plivo-name"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={addForm.control}
                name="authId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("adminDashboard.plivoCredentials.addDialog.authId")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder={t("adminDashboard.plivoCredentials.addDialog.authIdPlaceholder")}
                        data-testid="input-plivo-auth-id"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={addForm.control}
                name="authToken"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("adminDashboard.plivoCredentials.addDialog.authToken")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="password"
                        placeholder={t("adminDashboard.plivoCredentials.addDialog.authTokenPlaceholder")}
                        data-testid="input-plivo-auth-token"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={addForm.control}
                name="isPrimary"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="checkbox-plivo-primary"
                      />
                    </FormControl>
                    <FormLabel className="text-sm font-normal">
                      {t("adminDashboard.plivoCredentials.addDialog.setPrimary")}
                    </FormLabel>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAddDialogOpen(false)}>
                  {t("adminDashboard.plivoCredentials.addDialog.cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={addCredential.isPending}
                  data-testid="button-save-plivo-credential"
                >
                  {addCredential.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {t("adminDashboard.plivoCredentials.addDialog.addCredential")}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("adminDashboard.plivoCredentials.editDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("adminDashboard.plivoCredentials.editDialog.description", { name: selectedCredential?.name })}
            </DialogDescription>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit((data) => {
              if (selectedCredential) {
                updateCredential.mutate({ id: selectedCredential.id, updates: data });
              }
            })} className="space-y-4 py-4">
              <FormField
                control={editForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("adminDashboard.plivoCredentials.editDialog.name")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        data-testid="input-edit-plivo-name"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="space-y-2">
                <Label>{t("adminDashboard.plivoCredentials.editDialog.authId")}</Label>
                <Input
                  value={selectedCredential ? maskAuthId(selectedCredential.authId) : ""}
                  disabled
                  className="bg-muted font-mono"
                  data-testid="input-edit-plivo-auth-id"
                />
                <p className="text-xs text-muted-foreground">{t("adminDashboard.plivoCredentials.editDialog.authIdNote")}</p>
              </div>
              <FormField
                control={editForm.control}
                name="isPrimary"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="checkbox-edit-plivo-primary"
                      />
                    </FormControl>
                    <FormLabel className="text-sm font-normal">
                      {t("adminDashboard.plivoCredentials.editDialog.setPrimary")}
                    </FormLabel>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditDialogOpen(false)}>
                  {t("adminDashboard.plivoCredentials.editDialog.cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={updateCredential.isPending}
                  data-testid="button-update-plivo-credential"
                >
                  {updateCredential.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {t("adminDashboard.plivoCredentials.editDialog.update")}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("adminDashboard.plivoCredentials.deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("adminDashboard.plivoCredentials.deleteDialog.description", { name: selectedCredential?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteCredential.isPending}>
              {t("adminDashboard.plivoCredentials.deleteDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (selectedCredential) {
                  deleteCredential.mutate(selectedCredential.id);
                }
              }}
              disabled={deleteCredential.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-plivo"
            >
              {deleteCredential.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("adminDashboard.plivoCredentials.deleteDialog.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
