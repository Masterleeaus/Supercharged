import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";



import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";



import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, RotateCcw, AlertTriangle, CheckCircle, XCircle, Clock, Copy } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { format } from "date-fns";

import { Transaction, GATEWAY_COLORS, STATUS_COLORS } from "./types";

interface TransactionDetailsDialogProps {
  transaction: Transaction | null;
  open: boolean;
  onClose: () => void;
  onRefundComplete: () => void;
  formatCurrency: (amount: number | string, currency: string) => string;
}

export function TransactionDetailsDialog({ transaction, open, onClose, onRefundComplete, formatCurrency }: TransactionDetailsDialogProps) {
  const { t } = useTranslation();
  const [showRefundForm, setShowRefundForm] = useState(false);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const { toast } = useToast();

  const refundMutation = useMutation({
    mutationFn: async (data: { transactionId: string; amount: number; reason: string }) => {
      return apiRequest("POST", `/api/admin/refunds/${data.transactionId}`, {
        amount: data.amount,
        reason: data.reason,
      });
    },
    onSuccess: () => {
      toast({
        title: "Refund Initiated",
        description: "The refund has been submitted to the payment gateway.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/transactions"] });
      setShowRefundForm(false);
      setRefundAmount("");
      setRefundReason("");
      onRefundComplete();
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Refund Failed",
        description: error.message || "Failed to process refund",
      });
    },
  });

  const handleRefund = () => {
    if (!transaction) return;
    const amount = parseFloat(refundAmount);
    const maxAmount = parseFloat(transaction.amount);

    if (isNaN(amount) || amount <= 0) {
      toast({
        variant: "destructive",
        title: "Invalid Amount",
        description: "Please enter a valid refund amount greater than zero",
      });
      return;
    }

    if (amount > maxAmount) {
      toast({
        variant: "destructive",
        title: "Amount Too High",
        description: `Refund amount cannot exceed ${formatCurrency(maxAmount, transaction.currency)}`,
      });
      return;
    }

    refundMutation.mutate({
      transactionId: transaction.id,
      amount,
      reason: refundReason || "Refund requested by admin",
    });
  };

  const canRefund = transaction?.status === "completed" && !transaction?.hasRefunds;
  const maxRefundAmount = transaction ? parseFloat(transaction.amount) : 0;

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case "pending":
        return <Clock className="h-5 w-5 text-yellow-500" />;
      case "failed":
        return <XCircle className="h-5 w-5 text-red-500" />;
      case "refunded":
      case "partially_refunded":
        return <RotateCcw className="h-5 w-5 text-purple-500" />;
      default:
        return <AlertTriangle className="h-5 w-5 text-muted-foreground" />;
    }
  };

  if (!transaction) return null;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {getStatusIcon(transaction.status)}
            {t("adminDashboard.transactions.details.title")}
          </DialogTitle>
          <DialogDescription>
            {t("adminDashboard.transactions.details.id", { id: transaction.id })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Transaction Summary */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-muted-foreground text-xs">{t("adminDashboard.transactions.details.amount")}</Label>
              <p className="text-lg font-semibold">{formatCurrency(transaction.amount, transaction.currency)}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-muted-foreground text-xs">{t("adminDashboard.transactions.details.status")}</Label>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={STATUS_COLORS[transaction.status] || ""}>
                  {transaction.status.charAt(0).toUpperCase() + transaction.status.slice(1).replace("_", " ")}
                </Badge>
                {transaction.hasRefunds && (
                  <Badge variant="outline" className="bg-purple-500/10 text-purple-700 border-purple-500/30">
                    {t("adminDashboard.transactions.details.hasRefunds")}
                  </Badge>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-muted-foreground text-xs">{t("adminDashboard.transactions.details.type")}</Label>
              <Badge variant="outline" className={transaction.type === "subscription" ? "border-green-500/30 text-green-700" : "border-amber-500/30 text-amber-700"}>
                {transaction.type === "subscription" ? t("adminDashboard.transactions.types.subscription") : t("adminDashboard.transactions.types.credits")}
              </Badge>
            </div>
            <div className="space-y-1">
              <Label className="text-muted-foreground text-xs">{t("adminDashboard.transactions.details.gateway")}</Label>
              <Badge
                variant="outline"
                style={{
                  borderColor: GATEWAY_COLORS[transaction.gateway] || "#6B7280",
                  color: GATEWAY_COLORS[transaction.gateway] || "#6B7280",
                }}
              >
                {transaction.gateway.charAt(0).toUpperCase() + transaction.gateway.slice(1)}
              </Badge>
            </div>
          </div>

          <Separator />

          {/* Customer Info */}
          <div className="space-y-3">
            <h4 className="font-medium">{t("adminDashboard.transactions.details.customerInfo")}</h4>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">{t("common.name")}</Label>
                <p>{transaction.user?.name || t("common.na")}</p>
              </div>
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">{t("common.email")}</Label>
                <p>{transaction.user?.email || t("common.na")}</p>
              </div>
            </div>
          </div>

          <Separator />

          {/* Transaction Details */}
          <div className="space-y-3">
            <h4 className="font-medium">{t("adminDashboard.transactions.details.paymentDetails")}</h4>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">{t("adminDashboard.transactions.details.gatewayTxId")}</Label>
                {transaction.gatewayTransactionId ? (
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-xs break-all bg-muted px-2 py-1 rounded flex-1">{transaction.gatewayTransactionId}</code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() => {
                        navigator.clipboard.writeText(transaction.gatewayTransactionId!);
                        toast({ title: t("common.copied"), description: t("adminDashboard.transactions.toasts.txIdCopied") });
                      }}
                      data-testid="button-copy-gateway-tx-id"
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <p className="font-mono text-xs text-muted-foreground">{t("common.na")}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">{t("common.description")}</Label>
                <p>{transaction.planName || transaction.packageName || transaction.description}</p>
              </div>
              {transaction.creditsAwarded && (
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">{t("adminDashboard.transactions.details.creditsAwarded")}</Label>
                  <p>{t("adminDashboard.transactions.details.creditsCount", { count: transaction.creditsAwarded })}</p>
                </div>
              )}
              {transaction.billingPeriod && (
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">{t("adminDashboard.transactions.details.billingPeriod")}</Label>
                  <p>{transaction.billingPeriod}</p>
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">{t("adminDashboard.transactions.details.created")}</Label>
                <p>{format(new Date(transaction.createdAt), "PPpp")}</p>
              </div>
              {transaction.completedAt && (
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">{t("adminDashboard.transactions.details.completed")}</Label>
                  <p>{format(new Date(transaction.completedAt), "PPpp")}</p>
                </div>
              )}
            </div>
          </div>

          {/* Refund Section */}
          {canRefund && (
            <>
              <Separator />
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-medium">{t("adminDashboard.transactions.details.refund")}</h4>
                  {!showRefundForm && (
                    <Button variant="outline" size="sm" onClick={() => setShowRefundForm(true)} data-testid="button-show-refund-form">
                      <RotateCcw className="h-4 w-4 mr-2" />
                      {t("adminDashboard.transactions.details.issueRefund")}
                    </Button>
                  )}
                </div>

                {showRefundForm && (
                  <div className="space-y-4 p-4 bg-muted/50 rounded-lg border">
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>
                        {t("adminDashboard.transactions.details.refundAlert")}
                      </AlertDescription>
                    </Alert>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="refund-amount">{t("adminDashboard.transactions.details.refundAmount", { currency: transaction.currency })}</Label>
                        <Input
                          id="refund-amount"
                          type="number"
                          step="0.01"
                          min="0.01"
                          max={maxRefundAmount}
                          value={refundAmount}
                          onChange={(e) => setRefundAmount(e.target.value)}
                          placeholder={t("adminDashboard.transactions.details.maxAmount", { amount: maxRefundAmount.toFixed(2) })}
                          data-testid="input-refund-amount"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="refund-reason">{t("adminDashboard.transactions.details.reason")}</Label>
                        <Input
                          id="refund-reason"
                          value={refundReason}
                          onChange={(e) => setRefundReason(e.target.value)}
                          placeholder={t("adminDashboard.transactions.details.reasonPlaceholder")}
                          data-testid="input-refund-reason"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                      <Button variant="outline" onClick={() => setShowRefundForm(false)} data-testid="button-cancel-refund">
                        {t("common.cancel")}
                      </Button>
                      <Button
                        onClick={handleRefund}
                        disabled={refundMutation.isPending || !refundAmount}
                        data-testid="button-confirm-refund"
                      >
                        {refundMutation.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <RotateCcw className="h-4 w-4 mr-2" />
                        )}
                        {t("adminDashboard.transactions.details.processRefund")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Already Refunded Notice */}
          {transaction.hasRefunds && (
            <>
              <Separator />
              <Alert className="bg-purple-500/10 border-purple-500/20">
                <RotateCcw className="h-4 w-4 text-purple-500" />
                <AlertDescription className="text-purple-700 dark:text-purple-300">
                  {t("adminDashboard.transactions.details.refundedNotice")}
                </AlertDescription>
              </Alert>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-close-transaction-dialog">
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
