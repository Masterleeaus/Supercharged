import type { AppError } from "@/components/app-error";
import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Phone, RefreshCw, Users, UserPlus, Check, ChevronsUpDown } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import type { PlivoPhoneNumber, UserSearchResponse, User } from "./types";

export function PhoneNumbersSection() {
  const { toast } = useToast();
  const { t } = useTranslation();
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [selectedPhone, setSelectedPhone] = useState<PlivoPhoneNumber | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selectedUserLabel, setSelectedUserLabel] = useState<string>("");
  const [userSearchOpen, setUserSearchOpen] = useState(false);
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(userSearchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [userSearchQuery]);

  const { data: phoneNumbers, isLoading } = useQuery<PlivoPhoneNumber[]>({
    queryKey: ["/api/plivo/admin/phone-numbers"],
  });

  const userSearchUrl = (() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    params.set('limit', '50');
    return `/api/admin/users/search?${params.toString()}`;
  })();

  const { data: userSearchResponse, isLoading: isSearchingUsers } = useQuery<UserSearchResponse>({
    queryKey: [userSearchUrl],
    enabled: userSearchOpen,
    staleTime: 30000,
  });

  const filteredUsers = userSearchResponse?.users || [];

  const getSelectedUserLabel = useCallback(() => {
    if (selectedUserId === "system_pool") {
      return "System Pool (Free Users)";
    }
    if (selectedUserLabel) {
      return selectedUserLabel;
    }
    return "Select user or system pool";
  }, [selectedUserId, selectedUserLabel]);

  const syncNumbers = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/plivo/admin/sync-numbers");
    },
    onSuccess: (response: Response) => {
      // The mutation returns the raw Response, so these counts read as undefined at runtime (existing behaviour, see PR notes).
      const data = response as unknown as { imported?: number; skipped?: number };
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/phone-numbers"] });
      toast({
        title: "Sync Complete",
        description: `Imported ${data.imported} numbers, skipped ${data.skipped}`
      });
    },
    onError: (raw_error: Error) => {
      const error = raw_error as AppError;
      toast({
        title: "Sync Failed",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const assignNumber = useMutation({
    mutationFn: async ({ id, userId, isSystemPool }: { id: string; userId: string | null; isSystemPool: boolean }) => {
      return apiRequest("PATCH", `/api/plivo/admin/phone-numbers/${id}/assign`, {
        userId,
        isSystemPool,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plivo/admin/phone-numbers"] });
      toast({ title: "Phone number assigned successfully" });
      setAssignDialogOpen(false);
      setSelectedPhone(null);
    },
    onError: (raw_error: Error) => {
      const error = raw_error as AppError;
      toast({
        title: "Failed to assign phone number",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const handleOpenAssignDialog = (phone: PlivoPhoneNumber) => {
    setSelectedPhone(phone);
    setSelectedUserId(phone.userId || "system_pool");
    if (phone.userId && phone.userEmail) {
      setSelectedUserLabel(phone.userEmail + (phone.userName ? ` (${phone.userName})` : ""));
    } else {
      setSelectedUserLabel("");
    }
    setAssignDialogOpen(true);
  };

  const handleAssign = () => {
    if (!selectedPhone) return;
    const isSystemPool = selectedUserId === "system_pool";
    assignNumber.mutate({
      id: selectedPhone.id,
      userId: isSystemPool ? null : selectedUserId,
      isSystemPool,
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold">{t("adminDashboard.plivoSetting.title")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("adminDashboard.plivoSetting.description")}
          </p>
        </div>
        <Button
          onClick={() => syncNumbers.mutate()}
          disabled={syncNumbers.isPending}
          data-testid="button-sync-plivo-numbers"
        >
          {syncNumbers.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-2" />
          )}
          {t("adminDashboard.plivoSetting.syncButton")}
        </Button>
      </div>

      <Dialog open={assignDialogOpen} onOpenChange={(open) => {
        setAssignDialogOpen(open);
        if (!open) {
          setUserSearchQuery("");
          setUserSearchOpen(false);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("adminDashboard.plivoSetting.assignDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("adminDashboard.plivoSetting.assignDialog.description", { phoneNumber: selectedPhone?.phoneNumber })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t("adminDashboard.plivoSetting.assignDialog.assignTo")}</Label>
              <Popover open={userSearchOpen} onOpenChange={setUserSearchOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={userSearchOpen}
                    className="w-full justify-between font-normal"
                    data-testid="select-plivo-assign-user"
                  >
                    <span className="truncate">{getSelectedUserLabel()}</span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[400px] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder={t("adminDashboard.plivoSetting.assignDialog.searchPlaceholder")}
                      value={userSearchQuery}
                      onValueChange={setUserSearchQuery}
                      data-testid="input-plivo-user-search"
                    />
                    <CommandList>
                      {!isSearchingUsers && <CommandEmpty>{t("adminDashboard.plivoSetting.assignDialog.noUsersFound")}</CommandEmpty>}
                      <CommandGroup>
                        <CommandItem
                          value="system_pool"
                          onSelect={() => {
                            setSelectedUserId("system_pool");
                            setSelectedUserLabel("");
                            setUserSearchOpen(false);
                            setUserSearchQuery("");
                          }}
                          data-testid="option-plivo-system-pool"
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              selectedUserId === "system_pool" ? "opacity-100" : "opacity-0"
                            )}
                          />
                          <Users className="mr-2 h-4 w-4" />
                          {t("adminDashboard.plivoSetting.assignDialog.systemPool")}
                        </CommandItem>
                        {isSearchingUsers && (
                          <div className="flex items-center justify-center py-4">
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            <span className="text-sm text-muted-foreground">{t("plivoSetting.assignDialog.searching")}</span>
                          </div>
                        )}
                        {!isSearchingUsers && filteredUsers.map((user) => (
                          <CommandItem
                            key={user.id}
                            value={user.id}
                            onSelect={() => {
                              setSelectedUserId(user.id);
                              setSelectedUserLabel(user.email + (user.name ? ` (${user.name})` : ""));
                              setUserSearchOpen(false);
                              setUserSearchQuery("");
                            }}
                            data-testid={`option-plivo-user-${user.id}`}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                selectedUserId === user.id ? "opacity-100" : "opacity-0"
                              )}
                            />
                            <div className="flex flex-col">
                              <span>{user.email}</span>
                              {user.name && <span className="text-xs text-muted-foreground">{user.name}</span>}
                            </div>
                          </CommandItem>
                        ))}
                        {!isSearchingUsers && userSearchResponse?.hasMore && (
                          <div className="px-2 py-2 text-xs text-muted-foreground text-center border-t">
                            {t("adminDashboard.plivoSetting.assignDialog.searchMore", { total: userSearchResponse.total })}
                          </div>
                        )}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignDialogOpen(false)} data-testid="button-plivo-cancel-assign">
              {t("adminDashboard.plivoSetting.assignDialog.cancel")}
            </Button>
            <Button onClick={handleAssign} disabled={assignNumber.isPending} data-testid="button-plivo-confirm-assign">
              {assignNumber.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UserPlus className="h-4 w-4 mr-2" />}
              {t("adminDashboard.plivoSetting.assignDialog.assign")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("adminDashboard.plivoSetting.table.phoneNumber")}</TableHead>
              <TableHead>{t("adminDashboard.plivoSetting.table.country")}</TableHead>
              <TableHead>{t("adminDashboard.plivoSetting.table.type")}</TableHead>
              <TableHead>{t("adminDashboard.plivoSetting.table.status")}</TableHead>
              <TableHead>{t("adminDashboard.plivoSetting.table.assignment")}</TableHead>
              <TableHead>{t("adminDashboard.plivoSetting.table.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!phoneNumbers || phoneNumbers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  {t("adminDashboard.plivoSetting.table.noNumbers")}
                </TableCell>
              </TableRow>
            ) : (
              (Array.isArray(phoneNumbers) ? phoneNumbers : []).map((num) => (
                <TableRow key={num.id} data-testid={`row-plivo-number-${num.id}`}>
                  <TableCell className="font-mono" data-testid={`text-phone-${num.id}`}>
                    {num.phoneNumber}
                  </TableCell>
                  <TableCell>{num.country}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{num.numberType}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={num.status === 'active' ? 'default' : 'secondary'}>
                      {num.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {num.isSystemPool ? (
                      <Badge variant="outline">
                        <Users className="h-3 w-3 mr-1" />
                        {t("adminDashboard.plivoSetting.table.systemPool")}
                      </Badge>
                    ) : num.userId ? (
                      <Badge variant="secondary">{num.userEmail || t("adminDashboard.plivoSetting.table.assigned")}</Badge>
                    ) : (
                      <Badge variant="outline">{t("adminDashboard.plivoSetting.table.unassigned")}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleOpenAssignDialog(num)}
                      data-testid={`button-plivo-assign-${num.id}`}
                    >
                      <UserPlus className="h-4 w-4 mr-1" />
                      {num.userId || num.isSystemPool ? t("adminDashboard.plivoSetting.table.reassign") : t("adminDashboard.plivoSetting.table.assign")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
