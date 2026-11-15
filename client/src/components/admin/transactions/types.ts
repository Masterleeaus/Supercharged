export interface TransactionInvoice {
  id: string;
  invoiceNumber: string;
  pdfUrl?: string | null;
}

export interface Transaction {
  id: string;
  userId: string;
  type: string;
  gateway: string;
  gatewayTransactionId: string | null;
  amount: string;
  currency: string;
  status: string;
  description: string;
  planName?: string | null;
  packageName?: string | null;
  creditsAwarded?: number | null;
  billingPeriod?: string | null;
  createdAt: string;
  completedAt?: string | null;
  user?: { id: string; name: string; email: string } | null;
  hasRefunds?: boolean;
  invoice?: TransactionInvoice | null;
}

export interface Analytics {
  totalRevenue: number;
  revenueByGateway: Record<string, number>;
  revenueByType: Record<string, number>;
  transactionCount: number;
  transactionsByStatus: Record<string, number>;
  refundCount: number;
  totalRefunded: number;
}

export type TimeRange = 'week' | 'month' | 'year' | 'all';

export const GATEWAY_COLORS: Record<string, string> = {
  stripe: "#635BFF",
  razorpay: "#3395FF",
  paypal: "#003087",
  paystack: "#00C3F7",
  mercadopago: "#009EE3",
};

export const STATUS_COLORS: Record<string, string> = {
  completed: "bg-green-500/10 text-green-700 border-green-500/30",
  pending: "bg-yellow-500/10 text-yellow-700 border-yellow-500/30",
  failed: "bg-red-500/10 text-red-700 border-red-500/30",
  refunded: "bg-purple-500/10 text-purple-700 border-purple-500/30",
  partially_refunded: "bg-orange-500/10 text-orange-700 border-orange-500/30",
};

export const TYPE_COLORS: Record<string, string> = {
  subscription: "#10B981",
  credits: "#F59E0B",
};
