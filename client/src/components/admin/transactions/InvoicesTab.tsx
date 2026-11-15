import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { AuthStorage } from "@/lib/auth-storage";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";



import { Loader2, Download, FileText } from "lucide-react";

import { format } from "date-fns";


export function InvoicesTab() {
  const { t } = useTranslation();
  const { data: invoicesData, isLoading } = useQuery<{ invoices: any[]; isReadOnlyAdmin: boolean }>({
    queryKey: ["/api/admin/transactions/invoices/all"],
  });
  const invoices = invoicesData?.invoices;
  const isReadOnlyAdmin = invoicesData?.isReadOnlyAdmin ?? false;
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [exportStartDate, setExportStartDate] = useState("");
  const [exportEndDate, setExportEndDate] = useState("");
  const [exportType, setExportType] = useState<"all" | "invoices" | "refunds">("all");
  const { toast } = useToast();

  const formatCurrency = (amount: number | string, currency: string = "USD") => {
    const num = typeof amount === "string" ? parseFloat(amount) : amount;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(num);
  };

  const handleDownload = async (invoiceId: string, invoiceNumber: string) => {
    setDownloadingId(invoiceId);
    try {
      const authHeader = AuthStorage.getAuthHeader();
      if (!authHeader) throw new Error("Authentication required");
      const response = await fetch(`/api/invoices/admin/${invoiceId}/download`, {
        headers: { Authorization: authHeader },
      });

      if (!response.ok) {
        throw new Error("Failed to download invoice");
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Invoice-${invoiceNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({
        title: "Invoice Downloaded",
        description: `Invoice ${invoiceNumber} has been downloaded`,
      });
    } catch (error: any) {
      toast({
        title: "Download Failed",
        description: error.message || "Failed to download invoice",
        variant: "destructive",
      });
    } finally {
      setDownloadingId(null);
    }
  };

  const handleBulkDownload = async () => {
    setBulkDownloading(true);
    try {
      const authHeader = AuthStorage.getAuthHeader();
      if (!authHeader) throw new Error("Authentication required");

      const params = new URLSearchParams();
      if (exportStartDate) params.append("startDate", exportStartDate);
      if (exportEndDate) params.append("endDate", exportEndDate);
      params.append("type", exportType);

      const response = await fetch(`/api/admin/transactions/export/zip?${params}`, {
        headers: { Authorization: authHeader },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to download documents");
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;

      const contentDisposition = response.headers.get("Content-Disposition");
      const fileName = contentDisposition
        ? contentDisposition.split("filename=")[1]?.replace(/"/g, "")
        : `documents-export.zip`;

      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({
        title: "Export Downloaded",
        description: "Documents have been downloaded as ZIP file",
      });
    } catch (error: any) {
      toast({
        title: "Export Failed",
        description: error.message || "Failed to export documents",
        variant: "destructive",
      });
    } finally {
      setBulkDownloading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("adminDashboard.transactions.invoices.bulkExport")}</CardTitle>
          <CardDescription>{t("adminDashboard.transactions.invoices.bulkExportDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-2">
              <Label htmlFor="export-type">{t("adminDashboard.transactions.invoices.docType")}</Label>
              <Select value={exportType} onValueChange={(v) => setExportType(v as "all" | "invoices" | "refunds")}>
                <SelectTrigger className="w-[180px]" data-testid="select-export-type">
                  <SelectValue placeholder={t("common.selectType")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("adminDashboard.transactions.invoices.allDocs")}</SelectItem>
                  <SelectItem value="invoices">{t("adminDashboard.transactions.invoices.invoicesOnly")}</SelectItem>
                  <SelectItem value="refunds">{t("adminDashboard.transactions.invoices.refundsOnly")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="export-start-date">{t("adminDashboard.transactions.invoices.fromDate")}</Label>
              <Input
                id="export-start-date"
                type="date"
                value={exportStartDate}
                onChange={(e) => setExportStartDate(e.target.value)}
                className="w-[180px]"
                data-testid="input-export-start-date"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="export-end-date">{t("adminDashboard.transactions.invoices.toDate")}</Label>
              <Input
                id="export-end-date"
                type="date"
                value={exportEndDate}
                onChange={(e) => setExportEndDate(e.target.value)}
                className="w-[180px]"
                data-testid="input-export-end-date"
              />
            </div>
            <Button
              onClick={handleBulkDownload}
              disabled={bulkDownloading || isReadOnlyAdmin}
              data-testid="button-bulk-export"
            >
              {bulkDownloading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("adminDashboard.transactions.invoices.exporting")}
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" />
                  {t("adminDashboard.transactions.invoices.exportZip")}
                </>
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {t("adminDashboard.transactions.invoices.exportNote")}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("adminDashboard.transactions.invoices.title")}</CardTitle>
          <CardDescription>{t("adminDashboard.transactions.invoices.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {invoices && invoices.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("adminDashboard.transactions.invoices.invoiceNumber")}</TableHead>
                  <TableHead>{t("adminDashboard.transactions.table.date")}</TableHead>
                  <TableHead>{t("adminDashboard.transactions.table.customer")}</TableHead>
                  <TableHead>{t("common.description")}</TableHead>
                  <TableHead className="text-right">{t("adminDashboard.transactions.table.amount")}</TableHead>
                  <TableHead>{t("adminDashboard.transactions.table.status")}</TableHead>
                  <TableHead className="text-right">{t("adminDashboard.transactions.table.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((invoice) => (
                  <TableRow key={invoice.id} data-testid={`row-invoice-${invoice.id}`}>
                    <TableCell className="font-mono">{invoice.invoiceNumber}</TableCell>
                    <TableCell>{format(new Date(invoice.issuedAt), "MMM d, yyyy")}</TableCell>
                    <TableCell>
                      <div className="font-medium">{invoice.user?.name || invoice.customerName}</div>
                      <div className="text-xs text-muted-foreground">{invoice.user?.email || invoice.customerEmail}</div>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate">{invoice.description}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(invoice.total, invoice.currency)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          invoice.status === "paid"
                            ? "bg-green-500/10 text-green-700 border-green-500/30"
                            : invoice.status === "sent"
                              ? "bg-blue-500/10 text-blue-700 border-blue-500/30"
                              : "bg-gray-500/10 text-gray-700 border-gray-500/30"
                        }
                      >
                        {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {!isReadOnlyAdmin ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("adminDashboard.transactions.invoices.downloadPdf")}
                          disabled={downloadingId === invoice.id}
                          onClick={() => handleDownload(invoice.id, invoice.invoiceNumber)}
                          data-testid={`button-download-invoice-${invoice.id}`}
                        >
                          {downloadingId === invoice.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Download className="h-4 w-4" />
                          )}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>{t("adminDashboard.transactions.invoices.noInvoices")}</p>
              <p className="text-sm">{t("adminDashboard.transactions.invoices.noInvoicesDesc")}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
