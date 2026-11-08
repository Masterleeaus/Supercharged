import type { Express } from "express";
import { stripeRouter, razorpayRouter, paypalRouter, paystackRouter, mercadopagoRouter, yookassaRouter } from "../../engines/payment";

export function registerPaymentRoutes(app: Express): void {
  // Stripe routes
  app.use("/api/stripe", stripeRouter);

  // Razorpay routes (alternative payment gateway)
  app.use("/api/razorpay", razorpayRouter);

  // PayPal routes (global payment gateway)
  app.use("/api/paypal", paypalRouter);

  // Paystack routes (Africa payment gateway - NGN, GHS, ZAR, KES)
  app.use("/api/paystack", paystackRouter);

  // MercadoPago routes (Latin America payment gateway - BRL, MXN, ARS, CLP, COP)
  app.use("/api/mercadopago", mercadopagoRouter);

  // YooKassa routes
  app.use("/api/yookassa", yookassaRouter);
}
