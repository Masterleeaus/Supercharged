import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { AuthStorage } from "@/lib/auth-storage";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Download, RotateCcw } from "lucide-react";
import { format } from "date-fns";
import { formatCurrency } from "./formatCurrency";

interface Refund {
  id: string;
  transactionId: string;
  userId: string;
  amount: string;
  currency: string;
  reason: string | null;
  status: string;
  refundNoteNumber: string | null;
  pdfUrl: string | null;
  createdAt: string;
  user?: { id: string; name: string; email: string } | null;
  transaction?: { id: string; type: string; gateway: string; description: string } | null;
}

export function RefundsTab() {
  const { t } = useTranslation();
  const { data: refundsData, isLoading } = useQuery<Refund[]>({
    queryKey: ["/api/admin/refunds"],
  });
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const { toast } = useToast();


  const handleDownloadRefundNote = async (refundId: string, refundNoteNumber: string | null) => {
    setDownloadingId(refundId);
    try {
      const authHeader = AuthStorage.getAuthHeader();
      if (!authHeader) throw new Error(t("adminDashboard.transactions.toasts.authRequired"));
      const response = await fetch(`/api/admin/refunds/${refundId}/download`, {
        headers: { Authorization: authHeader },
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: t("adminDashboard.transactions.toasts.downloadFailed") }));
        throw new Error(error.message || t("adminDashboard.transactions.toasts.downloadFailed"));
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `RefundNote-${refundNoteNumber || refundId}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({
        title: t("adminDashboard.transactions.toasts.refundNoteDownloaded"),
        description: t("adminDashboard.transactions.toasts.refundNoteDownloadedDesc", { number: refundNoteNumber || "" }),
      });
    } catch (error: any) {
      toast({
        title: t("adminDashboard.transactions.toasts.downloadFailed"),
        description: error.message || t("adminDashboard.transactions.toasts.downloadFailed"),
        variant: "destructive",
      });
    } finally {
      setDownloadingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const completedRefunds = refundsData?.filter(r => r.status === 'completed') || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("adminDashboard.transactions.refundNotes.title")}</CardTitle>
        <CardDescription>{t("adminDashboard.transactions.refundNotes.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {completedRefunds.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("adminDashboard.transactions.refundNotes.refundNoteNumber")}</TableHead>
                <TableHead>{t("adminDashboard.transactions.table.date")}</TableHead>
                <TableHead>{t("adminDashboard.transactions.table.customer")}</TableHead>
                <TableHead>{t("common.transaction")}</TableHead>
                <TableHead className="text-right">{t("adminDashboard.transactions.table.amount")}</TableHead>
                <TableHead>{t("adminDashboard.transactions.table.status")}</TableHead>
                <TableHead className="text-right">{t("adminDashboard.transactions.table.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {completedRefunds.map((refund) => (
                <TableRow key={refund.id} data-testid={`row-refund-${refund.id}`}>
                  <TableCell className="font-mono">
                    {refund.refundNoteNumber || "-"}
                  </TableCell>
                  <TableCell>{format(new Date(refund.createdAt), "MMM d, yyyy")}</TableCell>
                  <TableCell>
                    <div className="font-medium">{refund.user?.name || t("common.unknown")}</div>
                    <div className="text-xs text-muted-foreground">{refund.user?.email || ""}</div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{refund.transaction?.gateway || ""}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-[150px]">
                      {refund.reason || refund.transaction?.description || ""}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatCurrency(refund.amount, refund.currency)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className="bg-green-500/10 text-green-700 border-green-500/30"
                    >
                      {t("common.completed")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      title={t("adminDashboard.transactions.refundNotes.downloadNote")}
                      disabled={downloadingId === refund.id}
                      onClick={() => handleDownloadRefundNote(refund.id, refund.refundNoteNumber)}
                      data-testid={`button-download-refund-note-${refund.id}`}
                    >
                      {downloadingId === refund.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="text-center py-12 text-muted-foreground">
            <RotateCcw className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>{t("adminDashboard.transactions.refundNotes.noNotes")}</p>
            <p className="text-sm">{t("adminDashboard.transactions.refundNotes.noNotesDesc")}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
