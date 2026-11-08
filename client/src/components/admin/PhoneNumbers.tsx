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
import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Loader2, Phone, Plus, Trash2, RefreshCw, UserPlus, Check, ChevronsUpDown, Users, KeyRound, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { AddSystemNumberDialog } from "./AddSystemNumberDialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface PhoneNumber {
  id: string;
  phoneNumber: string;
  status: string;
  isSystemPool: boolean;
  userId?: string;
  userEmail?: string;
  userName?: string;
  purchasePrice?: number;
  monthlyPrice?: number;
  createdAt: string;
}

interface User {
  id: string;
  email: string;
  name?: string | null;
}

interface UserSearchResponse {
  users: User[];
  total: number;
  hasMore: boolean;
}

import { useTranslation } from "react-i18next";

interface PhoneNumber {
  id: string;
  phoneNumber: string;
  status: string;
  isSystemPool: boolean;
  userId?: string;
  userEmail?: string;
  userName?: string;
  purchasePrice?: number;
  monthlyPrice?: number;
  createdAt: string;
}

interface User {
  id: string;
  email: string;
  name?: string | null;
}

interface UserSearchResponse {
  users: User[];
  total: number;
  hasMore: boolean;
}

function PhoneStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  if (status === 'active') {
    return <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">{t("common.active")}</Badge>;      
  }
  if (status === 'inactive') {
    return <Badge variant="secondary" className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400">{t("common.inactive")}</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

export default function PhoneNumbers() {
  const { t } = useTranslation();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [syncingToElevenLabs, setSyncingToElevenLabs] = useState(false);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [clearingSyncStatus, setClearingSyncStatus] = useState(false);
  const [resyncConfirmOpen, setResyncConfirmOpen] = useState(false);
  const [resyncingCredentials, setResyncingCredentials] = useState(false);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [selectedPhone, setSelectedPhone] = useState<PhoneNumber | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selectedUserLabel, setSelectedUserLabel] = useState<string>("");
  const [assigning, setAssigning] = useState(false);
  const [userSearchOpen, setUserSearchOpen] = useState(false);
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [reactivatingId, setReactivatingId] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(userSearchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [userSearchQuery]);

  const { data: phoneNumbers, isLoading } = useQuery<PhoneNumber[]>({
    queryKey: ["/api/admin/phone-numbers"],
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
      return t("adminDashboard.phoneNumbers.systemPool");
    }
    if (selectedUserLabel) {
      return selectedUserLabel;
    }
    return t("adminDashboard.phoneNumbers.selectUserOrPool");
  }, [selectedUserId, selectedUserLabel, t]);

  const handleOpenAssignDialog = (phone: PhoneNumber) => {
    setSelectedPhone(phone);
    setSelectedUserId(phone.userId || "system_pool");
    if (phone.userId && phone.userEmail) {
      setSelectedUserLabel(phone.userEmail + (phone.userName ? ` (${phone.userName})` : ""));
    } else {
      setSelectedUserLabel("");
    }
    setAssignDialogOpen(true);
  };

  const handleAssign = async () => {
    if (!selectedPhone) return;

    setAssigning(true);
    try {
      const isSystemPool = selectedUserId === "system_pool";
      await apiRequest("PATCH", `/api/admin/phone-numbers/${selectedPhone.id}/assign`, {
        userId: isSystemPool ? null : selectedUserId,
        isSystemPool,
      });

      await queryClient.invalidateQueries({ queryKey: ["/api/admin/phone-numbers"] });

      toast({
        title: t("adminDashboard.phoneNumbers.toasts.assigned"),
        description: isSystemPool
          ? t("adminDashboard.phoneNumbers.toasts.movedToPool", { number: selectedPhone.phoneNumber })
          : t("adminDashboard.phoneNumbers.toasts.assignedToUser", { number: selectedPhone.phoneNumber }),
      });

      setAssignDialogOpen(false);
      setSelectedPhone(null);
    } catch (error: any) {
      toast({
        title: t("common.error"),
        description: error.message || t("adminDashboard.phoneNumbers.toasts.assignFailed"),
        variant: "destructive",
      });
    } finally {
      setAssigning(false);
    }
  };

  const handleSyncToElevenLabs = async () => {
    setSyncingToElevenLabs(true);
    try {
      const response = await apiRequest("POST", "/api/admin/phone-numbers/sync-to-elevenlabs");
      const result: {
        total?: number;
        success?: number;
        failed?: number;
        successes?: string[];
        errors?: string[];
        message?: string;
      } = await response.json();

      const total = result.total || 0;
      const success = result.success || 0;
      const failed = result.failed || 0;

      // Invalidate phone numbers query to refresh the table
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/phone-numbers"] });

      // Handle mixed outcomes
      if (success > 0 && failed > 0) {
        toast({
          title: t("adminDashboard.phoneNumbers.toasts.partiallySynced"),
          description: t("adminDashboard.phoneNumbers.toasts.resyncCount", { synced: success, failed, total }),
          variant: "default",
        });
      } else if (success > 0) {
        toast({
          title: t("adminDashboard.phoneNumbers.toasts.syncComplete"),
          description: t("adminDashboard.phoneNumbers.toasts.syncSuccessCount", { count: success }),
        });
      } else if (failed > 0) {
        toast({
          title: t("adminDashboard.phoneNumbers.toasts.syncFailed"),
          description: result.errors ? result.errors.join(", ") : t("adminDashboard.phoneNumbers.toasts.syncFailedDesc", { count: failed }),
          variant: "destructive",
        });
      } else {
        toast({
          title: t("adminDashboard.phoneNumbers.toasts.alreadySynced"),
          description: result.message || t("adminDashboard.phoneNumbers.toasts.alreadySyncedDesc"),
        });
      }
    } catch (error: any) {
      toast({
        title: t("common.error"),
        description: error.message || t("adminDashboard.phoneNumbers.toasts.syncError"),
        variant: "destructive",
      });
    } finally {
      setSyncingToElevenLabs(false);
    }
  };

  const handleCleanup = async () => {
    setCleaningUp(true);
    try {
      const response = await apiRequest("POST", "/api/admin/phone-numbers/cleanup");
      const result: {
        total?: number;
        removed?: number;
        kept?: number;
        removed_numbers?: string[];
        errors?: string[];
        message?: string;
      } = await response.json();

      const total = result.total || 0;
      const removed = result.removed || 0;
      const kept = result.kept || 0;

      // Invalidate phone numbers query to refresh the table
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/phone-numbers"] });

      // Show results
      if (removed > 0) {
        toast({
          title: t("adminDashboard.phoneNumbers.toasts.cleanupComplete"),
          description: t("adminDashboard.phoneNumbers.toasts.cleanupDesc", { removed, kept }),
        });
      } else if (total > 0) {
        toast({
          title: t("adminDashboard.phoneNumbers.toasts.noCleanupNeeded"),
          description: t("adminDashboard.phoneNumbers.toasts.noCleanupNeededDesc", { count: total }),
        });
      } else {
        toast({
          title: t("adminDashboard.phoneNumbers.toasts.noNumbers"),
          description: result.message || t("adminDashboard.phoneNumbers.toasts.noNumbersDesc"),
        });
      }
    } catch (error: any) {
      toast({
        title: t("common.error"),
        description: error.message || t("adminDashboard.phoneNumbers.toasts.cleanupFailed"),
        variant: "destructive",
      });
    } finally {
      setCleaningUp(false);
    }
  };

  const handleClearSyncStatus = async () => {
    setClearingSyncStatus(true);
    try {
      const response = await apiRequest("POST", "/api/admin/phone-numbers/clear-sync-status");
      const result: {
        total?: number;
        cleared?: number;
        message?: string;
      } = await response.json();

      const cleared = result.cleared || 0;

      // Invalidate phone numbers query to refresh the table
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/phone-numbers"] });

      // Show success message
      if (cleared > 0) {
        toast({
          title: t("adminDashboard.phoneNumbers.toasts.syncStatusCleared"),
          description: result.message || t("adminDashboard.phoneNumbers.toasts.syncStatusClearedDesc", { count: cleared }),
        });
      } else {
        toast({
          title: t("adminDashboard.phoneNumbers.toasts.noNumbers"),
          description: result.message || t("adminDashboard.phoneNumbers.toasts.noNumbersDesc"),
        });
      }
    } catch (error: any) {
      toast({
        title: t("common.error"),
        description: error.message || t("adminDashboard.phoneNumbers.toasts.clearSyncFailed"),
        variant: "destructive",
      });
    } finally {
      setClearingSyncStatus(false);
    }
  };

  const handleReactivate = async (phone: PhoneNumber) => {
    setReactivatingId(phone.id);
    try {
      const response = await apiRequest("PATCH", `/api/admin/phone-numbers/${phone.id}/reactivate`);
      const result: { success?: boolean; message?: string; error?: string; resolution?: string } = await response.json();
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/phone-numbers"] });
      toast({
        title: t("adminDashboard.phoneNumbers.toasts.reactivated"),
        description: result.message || t("adminDashboard.phoneNumbers.toasts.reactivatedDesc", { number: phone.phoneNumber }),
      });
    } catch (error: any) {
      // Try to extract the full descriptive message from the server JSON body
      let description = t("adminDashboard.phoneNumbers.toasts.reactivateFailed");
      const data = error?.data || error?.response?.data;
      if (data?.message) {
        description = data.message;
      } else if (data?.error) {
        description = data.error;
      } else if (error?.message) {
        description = error.message;
      }
      toast({
        title: t("adminDashboard.phoneNumbers.toasts.cannotReactivate"),
        description,
        variant: "destructive",
      });
    } finally {
      setReactivatingId(null);
    }
  };

  const handleResyncCredentials = async () => {
    setResyncConfirmOpen(false);
    setResyncingCredentials(true);
    try {
      const response = await apiRequest("POST", "/api/admin/phone-numbers/resync-elevenlabs");
      const result: { synced?: number; failed?: number; errors?: string[]; message?: string } = await response.json();
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/phone-numbers"] });
      if ((result.failed ?? 0) > 0 && (result.synced ?? 0) > 0) {
        toast({
          title: t("adminDashboard.phoneNumbers.toasts.partiallyResynced"),
          description: result.message || t("adminDashboard.phoneNumbers.toasts.resyncCount", { synced: result.synced, failed: result.failed }),
          variant: "default",
        });
      } else if ((result.failed ?? 0) > 0) {
        toast({
          title: t("adminDashboard.phoneNumbers.toasts.resyncFailed"),
          description: result.errors?.join(", ") || result.message || t("adminDashboard.phoneNumbers.toasts.resyncFailedDesc"),
          variant: "destructive",
        });
      } else {
        toast({
          title: t("adminDashboard.phoneNumbers.toasts.credentialsResynced"),
          description: result.message || t("adminDashboard.phoneNumbers.toasts.credentialsResyncedDesc", { count: result.synced }),
        });
      }
    } catch (error: any) {
      toast({
        title: t("common.error"),
        description: error.message || t("adminDashboard.phoneNumbers.toasts.resyncError"),
        variant: "destructive",
      });
    } finally {
      setResyncingCredentials(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  const systemPoolNumbers = phoneNumbers?.filter(p => p.isSystemPool) || [];
  const userNumbers = phoneNumbers?.filter(p => !p.isSystemPool) || [];
  const totalPurchaseCost = systemPoolNumbers.reduce((sum, p) => sum + (parseFloat(p.purchasePrice as any) || 0), 0);
  const totalMonthlyCost = systemPoolNumbers.reduce((sum, p) => sum + (parseFloat(p.monthlyPrice as any) || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl md:text-2xl font-bold">{t("adminDashboard.phoneNumbers.title")}</h2>
          <p className="text-muted-foreground text-sm md:text-base">
            {t("adminDashboard.phoneNumbers.description")}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            onClick={handleCleanup}
            variant="outline"
            disabled={cleaningUp}
            data-testid="button-cleanup-numbers"
          >
            {cleaningUp ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t("adminDashboard.phoneNumbers.cleaning")}
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4 mr-2" />
                {t("adminDashboard.phoneNumbers.cleanupOrphaned")}
              </>
            )}
          </Button>
          <Button
            onClick={handleClearSyncStatus}
            variant="outline"
            disabled={clearingSyncStatus}
            data-testid="button-clear-sync-status"
          >
            {clearingSyncStatus ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t("adminDashboard.phoneNumbers.clearing")}
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4 mr-2" />
                {t("adminDashboard.phoneNumbers.clearSyncStatus")}
              </>
            )}
          </Button>
          <Button
            onClick={handleSyncToElevenLabs}
            variant="outline"
            disabled={syncingToElevenLabs}
            data-testid="button-sync-elevenlabs"
          >
            {syncingToElevenLabs ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t("adminDashboard.phoneNumbers.syncing")}
              </>
            ) : (
              <>
                <Phone className="h-4 w-4 mr-2" />
                {t("adminDashboard.phoneNumbers.syncToElevenLabs")}
              </>
            )}
          </Button>
          <Button
            onClick={() => setResyncConfirmOpen(true)}
            variant="outline"
            disabled={resyncingCredentials}
            data-testid="button-resync-twilio-credentials"
          >
            {resyncingCredentials ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t("adminDashboard.phoneNumbers.resyncing")}
              </>
            ) : (
              <>
                <KeyRound className="h-4 w-4 mr-2" />
                {t("adminDashboard.phoneNumbers.resyncCredentials")}
              </>
            )}
          </Button>
          <Button onClick={() => setAddDialogOpen(true)} data-testid="button-add-system-number">
            <Plus className="h-4 w-4 mr-2" />
            {t("adminDashboard.phoneNumbers.addSystemNumber")}
          </Button>
        </div>
      </div>

      <AddSystemNumberDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />

      <Dialog open={resyncConfirmOpen} onOpenChange={setResyncConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("adminDashboard.phoneNumbers.resyncTitle")}</DialogTitle>
            <DialogDescription>
              {t("adminDashboard.phoneNumbers.resyncDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 text-sm text-muted-foreground">
            {t("adminDashboard.phoneNumbers.resyncWarning")}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResyncConfirmOpen(false)} data-testid="button-resync-cancel">
              {t("common.cancel")}
            </Button>
            <Button onClick={handleResyncCredentials} data-testid="button-resync-confirm">
              {t("adminDashboard.phoneNumbers.resyncCredentials")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={assignDialogOpen} onOpenChange={(open) => {
        setAssignDialogOpen(open);
        if (!open) {
          setUserSearchQuery("");
          setUserSearchOpen(false);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("adminDashboard.phoneNumbers.assignTitle")}</DialogTitle>
            <DialogDescription>
              {t("adminDashboard.phoneNumbers.assignDesc", { number: selectedPhone?.phoneNumber })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t("adminDashboard.phoneNumbers.assignTo")}</Label>
              <Popover open={userSearchOpen} onOpenChange={setUserSearchOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={userSearchOpen}
                    className="w-full justify-between font-normal"
                    data-testid="select-assign-user"
                  >
                    <span className="truncate">{getSelectedUserLabel()}</span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[400px] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder={t("adminDashboard.phoneNumbers.searchPlaceholder")}
                      value={userSearchQuery}
                      onValueChange={setUserSearchQuery}
                      data-testid="input-user-search"
                    />
                    <CommandList>
                      {!isSearchingUsers && <CommandEmpty>{t("adminDashboard.phoneNumbers.noUsersFound")}</CommandEmpty>}
                      <CommandGroup>
                        <CommandItem
                          value="system_pool"
                          onSelect={() => {
                            setSelectedUserId("system_pool");
                            setSelectedUserLabel("");
                            setUserSearchOpen(false);
                            setUserSearchQuery("");
                          }}
                          data-testid="option-system-pool"
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              selectedUserId === "system_pool" ? "opacity-100" : "opacity-0"
                            )}
                          />
                          <Users className="mr-2 h-4 w-4" />
                          {t("adminDashboard.phoneNumbers.systemPool")}
                        </CommandItem>
                        {isSearchingUsers && (
                          <div className="flex items-center justify-center py-4">
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            <span className="text-sm text-muted-foreground">{t("adminDashboard.phoneNumbers.searching")}</span>
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
                            data-testid={`option-user-${user.id}`}
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
                            {t("adminDashboard.phoneNumbers.moreUsers", { count: userSearchResponse.total })}
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
            <Button variant="outline" onClick={() => setAssignDialogOpen(false)} data-testid="button-cancel-assign">
              {t("common.cancel")}
            </Button>
            <Button onClick={handleAssign} disabled={assigning} data-testid="button-confirm-assign">
              {assigning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UserPlus className="h-4 w-4 mr-2" />}
              {t("adminDashboard.phoneNumbers.actions.assign")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("adminDashboard.phoneNumbers.poolSize")}</CardTitle>
            <Phone className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{Array.isArray(systemPoolNumbers) ? systemPoolNumbers.length : 0}</div>
            <p className="text-xs text-muted-foreground">
              {t("adminDashboard.phoneNumbers.systemPhoneNumbers")}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("adminDashboard.phoneNumbers.totalCost")}</CardTitle>
            <Phone className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${totalPurchaseCost.toFixed(2)}</div>
            <p className="text-xs text-muted-foreground">
              {t("adminDashboard.phoneNumbers.purchaseCostDesc")}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("adminDashboard.phoneNumbers.monthlyCost")}</CardTitle>
            <Phone className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${totalMonthlyCost.toFixed(2)}</div>
            <p className="text-xs text-muted-foreground">
              {t("adminDashboard.phoneNumbers.monthlyCostDesc")}
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="system" className="space-y-4">
        <TabsList>
          <TabsTrigger value="system">{t("adminDashboard.phoneNumbers.tabs.system", { count: Array.isArray(systemPoolNumbers) ? systemPoolNumbers.length : 0 })}</TabsTrigger>
          <TabsTrigger value="user">{t("adminDashboard.phoneNumbers.tabs.user", { count: Array.isArray(userNumbers) ? userNumbers.length : 0 })}</TabsTrigger>
        </TabsList>

        <TabsContent value="system">
          <div className="rounded-md border">
            <Table>
              <TableCaption>{t("adminDashboard.phoneNumbers.tableCaptions.system")}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("adminDashboard.phoneNumbers.columns.phoneNumber")}</TableHead>
                  <TableHead>{t("adminDashboard.phoneNumbers.columns.status")}</TableHead>
                  <TableHead>{t("adminDashboard.phoneNumbers.columns.type")}</TableHead>
                  <TableHead>{t("adminDashboard.phoneNumbers.columns.purchasePrice")}</TableHead>
                  <TableHead>{t("adminDashboard.phoneNumbers.columns.monthlyPrice")}</TableHead>
                  <TableHead>{t("adminDashboard.phoneNumbers.columns.added")}</TableHead>
                  <TableHead>{t("adminDashboard.phoneNumbers.columns.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {systemPoolNumbers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center">
                      {t("adminDashboard.phoneNumbers.noNumbersDesc")}
                    </TableCell>
                  </TableRow>
                ) : (
                  (Array.isArray(systemPoolNumbers) ? systemPoolNumbers : []).map((phone) => (
                    <TableRow key={phone.id}>
                      <TableCell className="font-mono">{phone.phoneNumber}</TableCell>
                      <TableCell>
                        <PhoneStatusBadge status={phone.status} />
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{t("adminDashboard.phoneNumbers.systemPool")}</Badge>
                      </TableCell>
                      <TableCell>${phone.purchasePrice ? parseFloat(phone.purchasePrice as any).toFixed(2) : "0.00"}</TableCell>
                      <TableCell>${phone.monthlyPrice ? parseFloat(phone.monthlyPrice as any).toFixed(2) : "0.00"}</TableCell>
                      <TableCell>
                        {format(new Date(phone.createdAt), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {phone.status === 'inactive' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleReactivate(phone)}
                              disabled={reactivatingId === phone.id}
                              data-testid={`button-reactivate-${phone.id}`}
                            >
                              {reactivatingId === phone.id ? (
                                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                              ) : (
                                <RotateCcw className="h-4 w-4 mr-1" />
                              )}
                              {t("adminDashboard.phoneNumbers.actions.reactivate")}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleOpenAssignDialog(phone)}
                            data-testid={`button-assign-${phone.id}`}
                          >
                            <UserPlus className="h-4 w-4 mr-1" />
                            {t("adminDashboard.phoneNumbers.actions.assign")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="user">
          <div className="rounded-md border">
            <Table>
              <TableCaption>{t("adminDashboard.phoneNumbers.tableCaptions.user")}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("adminDashboard.phoneNumbers.columns.phoneNumber")}</TableHead>
                  <TableHead>{t("adminDashboard.phoneNumbers.columns.status")}</TableHead>
                  <TableHead>{t("adminDashboard.phoneNumbers.columns.user")}</TableHead>
                  <TableHead>{t("adminDashboard.phoneNumbers.columns.purchasePrice")}</TableHead>
                  <TableHead>{t("adminDashboard.phoneNumbers.columns.monthlyPrice")}</TableHead>
                  <TableHead>{t("adminDashboard.phoneNumbers.columns.added")}</TableHead>
                  <TableHead>{t("adminDashboard.phoneNumbers.columns.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {userNumbers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center">
                      {t("adminDashboard.phoneNumbers.noNumbersDesc")}
                    </TableCell>
                  </TableRow>
                ) : (
                  (Array.isArray(userNumbers) ? userNumbers : []).map((phone) => (
                    <TableRow key={phone.id} className={phone.status === 'inactive' ? 'bg-red-50/50 dark:bg-red-950/20' : undefined}>       
                      <TableCell className="font-mono">{phone.phoneNumber}</TableCell>
                      <TableCell>
                        <PhoneStatusBadge status={phone.status} />
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{phone.userEmail || t("common.unknown")}</Badge>
                      </TableCell>
                      <TableCell>${phone.purchasePrice ? parseFloat(phone.purchasePrice as any).toFixed(2) : "0.00"}</TableCell>
                      <TableCell>${phone.monthlyPrice ? parseFloat(phone.monthlyPrice as any).toFixed(2) : "0.00"}</TableCell>
                      <TableCell>
                        {format(new Date(phone.createdAt), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {phone.status === 'inactive' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleReactivate(phone)}
                              disabled={reactivatingId === phone.id}
                              data-testid={`button-reactivate-${phone.id}`}
                            >
                              {reactivatingId === phone.id ? (
                                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                              ) : (
                                <RotateCcw className="h-4 w-4 mr-1" />
                              )}
                              {t("adminDashboard.phoneNumbers.actions.reactivate")}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleOpenAssignDialog(phone)}
                            data-testid={`button-assign-${phone.id}`}
                          >
                            <UserPlus className="h-4 w-4 mr-1" />
                            {t("adminDashboard.phoneNumbers.actions.reassign")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}