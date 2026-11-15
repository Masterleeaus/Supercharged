'use strict';
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

import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { AuthStorage } from "@/lib/auth-storage";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, DollarSign, CreditCard, TrendingUp, Receipt, RefreshCw, Filter, Download, Eye, FileText, Plus, RotateCcw, AlertTriangle } from "lucide-react";
import { format } from "date-fns";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from "recharts";
import { InvoicesTab } from "./transactions/InvoicesTab";
import { RefundsTab } from "./transactions/RefundsTab";
import { TransactionDetailsDialog } from "./transactions/TransactionDetailsDialog";
import { GATEWAY_COLORS, STATUS_COLORS, TYPE_COLORS } from "./transactions/types";
import type { Transaction, Analytics, TimeRange } from "./transactions/types";
import { formatCurrency } from "./transactions/formatCurrency";

export default function TransactionsManagement() {
  const [gatewayFilter, setGatewayFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [generatingInvoice, setGeneratingInvoice] = useState<string | null>(null);
  const [downloadingInvoice, setDownloadingInvoice] = useState<string | null>(null);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [showRefundDialog, setShowRefundDialog] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const { toast } = useToast();

  const { data: transactionsData, isLoading: transactionsLoading, refetch } = useQuery<{ transactions: Transaction[]; isReadOnlyAdmin: boolean }>({
    queryKey: ["/api/admin/transactions", gatewayFilter, typeFilter, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (gatewayFilter !== "all") params.append("gateway", gatewayFilter);
      if (typeFilter !== "all") params.append("type", typeFilter);
      if (statusFilter !== "all") params.append("status", statusFilter);

      const authHeader = AuthStorage.getAuthHeader();
      if (!authHeader) throw new Error("Authentication required");
      const response = await fetch(`/api/admin/transactions?${params}`, {
        headers: { Authorization: authHeader },
      });
      if (!response.ok) throw new Error("Failed to fetch transactions");
      return response.json();
    },
  });

  const transactions = transactionsData?.transactions;
  const isReadOnlyAdmin = transactionsData?.isReadOnlyAdmin ?? false;
  const { t } = useTranslation();
  const { data: analytics, isLoading: analyticsLoading, error: analyticsError } = useQuery<Analytics>({
    queryKey: ["/api/admin/transactions/analytics", timeRange],
    queryFn: async () => {
      const authHeader = AuthStorage.getAuthHeader();
      if (!authHeader) throw new Error("Authentication required");
      const response = await fetch(`/api/admin/transactions/analytics?timeRange=${timeRange}`, {
        headers: { Authorization: authHeader },
      });
      if (!response.ok) throw new Error("Failed to fetch analytics");
      return response.json();
    },
    retry: 2,
    staleTime: 30000,
  });

  const filteredTransactions = transactions?.filter((tx) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      tx.user?.name?.toLowerCase().includes(term) ||
      tx.user?.email?.toLowerCase().includes(term) ||
      tx.gatewayTransactionId?.toLowerCase().includes(term) ||
      tx.description.toLowerCase().includes(term)
    );
  });

  const handleDownloadInvoice = async (invoiceId: string, invoiceNumber: string) => {
    setDownloadingInvoice(invoiceId);
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
      setDownloadingInvoice(null);
    }
  };

  const handleGenerateInvoice = async (transactionId: string) => {
    setGeneratingInvoice(transactionId);
    try {
      const authHeader = AuthStorage.getAuthHeader();
      if (!authHeader) throw new Error("Authentication required");
      const response = await fetch(`/api/invoices/admin/${transactionId}/generate`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ regenerate: false }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to generate invoice");
      }

      const result = await response.json();

      toast({
        title: result.alreadyExists ? t("adminDashboard.transactions.toasts.invoiceExists") : t("adminDashboard.transactions.toasts.invoiceGenerated"),
        description: result.alreadyExists
          ? t("adminDashboard.transactions.toasts.invoiceExistsDesc", { number: result.invoice?.invoiceNumber || "" })
          : t("adminDashboard.transactions.toasts.invoiceGeneratedDesc", { id: result.invoice?.invoiceNumber || "" }),
      });

      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/admin/transactions/invoices/all"] });
    } catch (error: any) {
      toast({
        title: "Generation Failed",
        description: error.message || "Failed to generate invoice",
        variant: "destructive",
      });
    } finally {
      setGeneratingInvoice(null);
    }
  };

  const gatewayChartData = analytics?.revenueByGateway
    ? Object.entries(analytics.revenueByGateway).map(([gateway, revenue]) => ({
      name: gateway.charAt(0).toUpperCase() + gateway.slice(1),
      value: revenue,
      fill: GATEWAY_COLORS[gateway] || "#6B7280",
    }))
    : [];

  const typeChartData = analytics?.revenueByType
    ? Object.entries(analytics.revenueByType).map(([type, revenue]) => ({
      name: type === "subscription" ? "Subscriptions" : "Credit Packages",
      value: revenue,
      fill: TYPE_COLORS[type] || "#6B7280",
    }))
    : [];

  const statusChartData = analytics?.transactionsByStatus
    ? Object.entries(analytics.transactionsByStatus).map(([status, count]) => ({
      name: status.charAt(0).toUpperCase() + status.slice(1).replace("_", " "),
      count,
    }))
    : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold" data-testid="text-transactions-title">{t("adminDashboard.transactions.title")}</h2>
          <p className="text-muted-foreground">
            {t("adminDashboard.transactions.subtitle")}
          </p>
        </div>
        <Button variant="outline" onClick={() => refetch()} data-testid="button-refresh-transactions">
          <RefreshCw className="h-4 w-4 mr-2" />
          {t("common.refresh")}
        </Button>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview" data-testid="tab-transactions-overview">
            <TrendingUp className="h-4 w-4 mr-2" />
            {t("adminDashboard.transactions.tabs.overview")}
          </TabsTrigger>
          <TabsTrigger value="transactions" data-testid="tab-transactions-list">
            <Receipt className="h-4 w-4 mr-2" />
            {t("adminDashboard.transactions.tabs.history")}
          </TabsTrigger>
          <TabsTrigger value="invoices" data-testid="tab-transactions-invoices">
            <FileText className="h-4 w-4 mr-2" />
            {t("adminDashboard.transactions.tabs.invoices")}
          </TabsTrigger>
          <TabsTrigger value="refunds" data-testid="tab-transactions-refunds">
            <RotateCcw className="h-4 w-4 mr-2" />
            {t("adminDashboard.transactions.tabs.refunds")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t("common.timePeriod")}:</span>
            </div>
            <div className="flex items-center gap-1 p-1 bg-muted rounded-lg">
              {(['week', 'month', 'year', 'all'] as TimeRange[]).map((range) => (
                <Button
                  key={range}
                  variant={timeRange === range ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setTimeRange(range)}
                  data-testid={`button-time-range-${range}`}
                >
                  {range === 'week' ? t("common.weekly") : range === 'month' ? t("common.monthly") : range === 'year' ? t("common.yearly") : t("common.allTime")}
                </Button>
              ))}
            </div>
          </div>

          {analyticsLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : analyticsError ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {t("adminDashboard.transactions.toasts.analyticsFailed")}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">{t("adminDashboard.transactions.stats.totalRevenue")}</CardTitle>
                    <DollarSign className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold" data-testid="text-total-revenue">
                      {formatCurrency(analytics?.totalRevenue || 0)}
                    </div>
                    <p className="text-xs text-muted-foreground">{t("adminDashboard.transactions.stats.totalRevenueDesc")}</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">{t("adminDashboard.transactions.stats.totalTransactions")}</CardTitle>
                    <CreditCard className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold" data-testid="text-transaction-count">
                      {analytics?.transactionCount || 0}
                    </div>
                    <p className="text-xs text-muted-foreground">{timeRange === 'all' ? t("common.allTime") : t("common.last", { range: timeRange })}</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">{t("adminDashboard.transactions.stats.totalRefunded")}</CardTitle>
                    <RotateCcw className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold" data-testid="text-refund-count">
                      {analytics?.refundCount || 0}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatCurrency(analytics?.totalRefunded || 0)} {t("adminDashboard.transactions.stats.amountRefunded")}
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">{t("common.activeGateways")}</CardTitle>
                    <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold" data-testid="text-active-gateways">
                      {Object.keys(analytics?.revenueByGateway || {}).length}
                    </div>
                    <p className="text-xs text-muted-foreground">{t("common.gatewaysUsed")}</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">{t("common.successRate")}</CardTitle>
                    <Receipt className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold" data-testid="text-success-rate">
                      {analytics?.transactionCount
                        ? Math.round(
                          (((analytics.transactionsByStatus?.completed || 0) +
                            (analytics.transactionsByStatus?.refunded || 0) +
                            (analytics.transactionsByStatus?.partially_refunded || 0)) / analytics.transactionCount) * 100
                        )
                        : 0}%
                    </div>
                    <p className="text-xs text-muted-foreground">{t("common.paymentsCollected")}</p>
                  </CardContent>
                </Card>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">{t("adminDashboard.transactions.stats.revenueByGateway")}</CardTitle>
                    <CardDescription>{t("common.distributionProviders")}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {gatewayChartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={250}>
                        <PieChart>
                          <Pie
                            data={gatewayChartData}
                            cx="50%"
                            cy="50%"
                            innerRadius={60}
                            outerRadius={80}
                            paddingAngle={2}
                            dataKey="value"
                            label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                          >
                            {gatewayChartData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.fill} />
                            ))}
                          </Pie>
                          <Tooltip formatter={(value: number) => formatCurrency(value)} />
                          <Legend />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="flex items-center justify-center h-[250px] text-muted-foreground">
                        {t("common.noDataAvailable")}
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">{t("adminDashboard.transactions.stats.revenueByType")}</CardTitle>
                    <CardDescription>{t("common.distributionTypes")}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {typeChartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={250}>
                        <BarChart data={typeChartData}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="name" />
                          <YAxis tickFormatter={(value) => `$${value}`} />
                          <Tooltip formatter={(value: number) => formatCurrency(value)} />
                          <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                            {typeChartData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.fill} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="flex items-center justify-center h-[250px] text-muted-foreground">
                        {t("common.noDataAvailable")}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">{t("common.transactionStatusDistribution")}</CardTitle>
                  <CardDescription>{t("common.overviewOutcomes")}</CardDescription>
                </CardHeader>
                <CardContent>
                  {statusChartData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={statusChartData} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis type="number" />
                        <YAxis dataKey="name" type="category" width={120} />
                        <Tooltip />
                        <Bar dataKey="count" fill="#6366F1" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex items-center justify-center h-[200px] text-muted-foreground">
                      {t("common.noDataAvailable")}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="transactions" className="space-y-4" data-testid="transactions-tab-content">
          <Card>
            <CardHeader>
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                  <CardTitle>{t("adminDashboard.transactions.table.noTransactions")}</CardTitle>
                  <CardDescription>{t("adminDashboard.transactions.filters.search")}</CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    placeholder={t("adminDashboard.transactions.filters.search")}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-64"
                    data-testid="input-search-transactions"
                  />
                  <Select value={gatewayFilter} onValueChange={setGatewayFilter}>
                    <SelectTrigger className="w-36" data-testid="select-gateway-filter">
                      <SelectValue placeholder={t("adminDashboard.transactions.filters.gateway")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t("adminDashboard.transactions.filters.allGateways")}</SelectItem>
                      <SelectItem value="stripe">Stripe</SelectItem>
                      <SelectItem value="razorpay">Razorpay</SelectItem>
                      <SelectItem value="paypal">PayPal</SelectItem>
                      <SelectItem value="paystack">Paystack</SelectItem>
                      <SelectItem value="mercadopago">MercadoPago</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={typeFilter} onValueChange={setTypeFilter}>
                    <SelectTrigger className="w-36" data-testid="select-type-filter">
                      <SelectValue placeholder={t("adminDashboard.transactions.filters.type")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t("adminDashboard.transactions.filters.allTypes")}</SelectItem>
                      <SelectItem value="subscription">{t("adminDashboard.transactions.types.subscription")}</SelectItem>
                      <SelectItem value="credits">{t("adminDashboard.transactions.types.credits")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-36" data-testid="select-status-filter">
                      <SelectValue placeholder={t("adminDashboard.transactions.filters.status")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t("adminDashboard.transactions.filters.allStatuses")}</SelectItem>
                      <SelectItem value="completed">{t("common.completed")}</SelectItem>
                      <SelectItem value="pending">{t("common.pending")}</SelectItem>
                      <SelectItem value="failed">{t("common.failed")}</SelectItem>
                      <SelectItem value="refunded">{t("common.refunded")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {transactionsLoading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : filteredTransactions && filteredTransactions.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("adminDashboard.transactions.table.date")}</TableHead>
                        <TableHead>{t("adminDashboard.transactions.table.customer")}</TableHead>
                        <TableHead>{t("adminDashboard.transactions.table.type")}</TableHead>
                        <TableHead>{t("common.description")}</TableHead>
                        <TableHead>{t("adminDashboard.transactions.table.gateway")}</TableHead>
                        <TableHead className="text-right">{t("adminDashboard.transactions.table.amount")}</TableHead>
                        <TableHead>{t("adminDashboard.transactions.table.status")}</TableHead>
                        <TableHead>{t("adminDashboard.transactions.table.invoice")}</TableHead>
                        <TableHead className="text-right">{t("adminDashboard.transactions.table.actions")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredTransactions.map((tx) => (
                        <TableRow key={tx.id} data-testid={`row-transaction-${tx.id}`}>
                          <TableCell className="whitespace-nowrap">
                            {format(new Date(tx.createdAt), "MMM d, yyyy")}
                            <div className="text-xs text-muted-foreground">
                              {format(new Date(tx.createdAt), "HH:mm")}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium">{tx.user?.name || t("common.unknown")}</div>
                            <div className="text-xs text-muted-foreground">{tx.user?.email}</div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={tx.type === "subscription" ? "border-green-500/30 text-green-700" : "border-amber-500/30 text-amber-700"}>
                              {tx.type === "subscription" ? t("common.plan") : t("common.credits")}
                            </Badge>
                          </TableCell>
                          <TableCell className="max-w-[200px] truncate">
                            {tx.planName || tx.packageName || tx.description}
                            {tx.creditsAwarded && (
                              <div className="text-xs text-muted-foreground">
                                +{tx.creditsAwarded.toLocaleString()} {t("common.credits")}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              style={{
                                borderColor: GATEWAY_COLORS[tx.gateway] || "#6B7280",
                                color: GATEWAY_COLORS[tx.gateway] || "#6B7280",
                              }}
                            >
                              {tx.gateway.charAt(0).toUpperCase() + tx.gateway.slice(1)}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency(tx.amount, tx.currency)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={STATUS_COLORS[tx.status] || ""}>
                              {tx.status.charAt(0).toUpperCase() + tx.status.slice(1).replace("_", " ")}
                            </Badge>
                            {tx.hasRefunds && (
                              <Badge variant="outline" className="ml-1 bg-purple-500/10 text-purple-700 border-purple-500/30">
                                {t("adminDashboard.transactions.details.refund")}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            {tx.invoice ? (
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-mono">{tx.invoice.invoiceNumber}</span>
                                {!isReadOnlyAdmin && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    title={t("adminDashboard.transactions.invoices.downloadPdf")}
                                    disabled={downloadingInvoice === tx.invoice.id}
                                    onClick={() => handleDownloadInvoice(tx.invoice!.id, tx.invoice!.invoiceNumber)}
                                    data-testid={`button-download-invoice-${tx.id}`}
                                  >
                                    {downloadingInvoice === tx.invoice.id ? (
                                      <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                      <Download className="h-4 w-4" />
                                    )}
                                  </Button>
                                )}
                              </div>
                            ) : tx.status === "completed" && !isReadOnlyAdmin ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={generatingInvoice === tx.id}
                                onClick={() => handleGenerateInvoice(tx.id)}
                                data-testid={`button-generate-invoice-${tx.id}`}
                              >
                                {generatingInvoice === tx.id ? (
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                ) : (
                                  <Plus className="h-3 w-3 mr-1" />
                                )}
                                {t("adminDashboard.transactions.table.generate")}
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t("common.viewDetails")}
                              onClick={() => setSelectedTransaction(tx)}
                              data-testid={`button-view-transaction-${tx.id}`}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="text-center py-12 text-muted-foreground">
                  <Receipt className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>{t("adminDashboard.transactions.table.noTransactions")}</p>
                  <p className="text-sm">{t("adminDashboard.transactions.table.noTransactionsDesc")}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="invoices" className="space-y-4">
          <InvoicesTab />
        </TabsContent>

        <TabsContent value="refunds" className="space-y-4">
          <RefundsTab />
        </TabsContent>
      </Tabs>

      {/* Transaction Details Dialog */}
      <TransactionDetailsDialog
        transaction={selectedTransaction}
        open={!!selectedTransaction}
        onClose={() => setSelectedTransaction(null)}
        onRefundComplete={() => {
          setSelectedTransaction(null);
          refetch();
        }}
        formatCurrency={formatCurrency}
      />
    </div>
  );
}
