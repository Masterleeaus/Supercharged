'use strict';
/**
 * YooKassa Webhook Event Handlers
 * Pure functions for processing webhook events
 */

import { storage } from '../../../../storage';
import { NotificationService } from '../../../../services/notification-service';
import { syncUserWithSubscription, applyPlanCredits } from '../../../../services/membership-service';
import { emailService } from '../../../../services/email-service';
import { generateInvoiceForTransaction } from '../../invoice-service';
import { PaymentAuditService } from '../../audit';

export interface HandlerResult {
  success: boolean;
  action?: string;
  error?: string;
  userId?: string;
  transactionId?: string;
}

export async function handlePaymentSucceeded(
  object: any
): Promise<HandlerResult> {
  const paymentId = object.id;
  const metadata = object.metadata || {};
  const userId = metadata.userId;
  const type = metadata.type; // 'credits' or 'subscription'

  if (!userId) {
    return { success: false, error: 'No userId in transaction metadata' };
  }

  const existingTx = await storage.getPaymentTransactionByGatewayId('yookassa', paymentId);
  if (existingTx) {
    return { success: true, action: 'already_processed', userId, transactionId: existingTx.id };
  }

  if (type === 'credits') {
    return handleCreditsPayment(object, userId, metadata);
  } else if (type === 'subscription') {
    return handleSubscriptionPayment(object, userId, metadata);
  }

  return { success: true, action: 'unknown_type', userId };
}

async function handleCreditsPayment(
  object: any,
  userId: string,
  metadata: any
): Promise<HandlerResult> {
  const packageId = metadata.packageId;
  const credits = parseInt(metadata.credits || '0', 10);
  
  if (!packageId || !credits) {
    return { success: false, error: 'Invalid credits payment metadata' };
  }

  const pkg = await storage.getCreditPackage(packageId);
  if (!pkg) {
    return { success: false, error: 'Credit package not found' };
  }

  try {
    await storage.addCreditsAtomic(userId, credits, `Purchased ${pkg.name}`, object.id);

    const amount = object.amount.value;
    const currency = object.amount.currency || 'RUB';

    const creditTransaction = await storage.createPaymentTransaction({
      userId,
      type: 'credits',
      gateway: 'yookassa',
      gatewayTransactionId: object.id,
      amount,
      currency: currency.toUpperCase(),
      creditPackageId: packageId,
      description: `${pkg.name} - ${credits} Credits`,
      creditsAwarded: credits,
      status: 'completed',
      completedAt: new Date(),
    });

    await PaymentAuditService.logCreditsAwarded(
      'yookassa',
      userId,
      creditTransaction.id,
      credits,
      { packageName: pkg.name, amount: parseFloat(amount) }
    );

    try {
      await generateInvoiceForTransaction(creditTransaction.id);
      await emailService.sendPurchaseConfirmation(creditTransaction.id);
    } catch (emailError: any) {
      console.error(`❌ [YooKassa] Failed to send credits purchase confirmation email:`, emailError);
    }

    return {
      success: true,
      action: 'credits_awarded',
      userId,
      transactionId: creditTransaction.id,
    };
  } catch (error: any) {
    if (error.message?.includes('unique') || error.message?.includes('duplicate')) {
      return { success: true, action: 'credits_already_processed', userId };
    }
    throw error;
  }
}

async function handleSubscriptionPayment(
  object: any,
  userId: string,
  metadata: any
): Promise<HandlerResult> {
  const planId = metadata.planId;
  const billingPeriod = metadata.billingPeriod || 'monthly';

  if (!planId) {
    return { success: false, error: 'No planId in subscription metadata' };
  }

  const plan = await storage.getPlan(planId);
  if (!plan) {
    return { success: false, error: 'Plan not found' };
  }

  const currentPeriodEnd = new Date();
  if (billingPeriod === 'yearly') {
    currentPeriodEnd.setFullYear(currentPeriodEnd.getFullYear() + 1);
  } else {
    currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);
  }

  const existingSub = await storage.getUserSubscription(userId);

  if (existingSub) {
    console.log(`[YooKassa] Updating existing subscription ${existingSub.id} for user ${userId}`);
    await storage.updateUserSubscription(existingSub.id, {
      planId,
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd,
      yookassaSubscriptionId: object.id,
      cancelAtPeriodEnd: false,
      billingPeriod,
      // Clear other gateway IDs when switching to YooKassa
      stripeSubscriptionId: null,
      razorpaySubscriptionId: null,
      paypalSubscriptionId: null,
      paystackSubscriptionCode: null,
      paystackCustomerCode: null,
      paystackEmailToken: null,
      mercadopagoSubscriptionId: null,
    });
  } else {
    await storage.createUserSubscription({
      userId,
      planId,
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd,
      yookassaSubscriptionId: object.id,
      cancelAtPeriodEnd: false,
      billingPeriod,
    });
  }

  await storage.updateUser(userId, {
    planType: plan.name,
    planExpiresAt: currentPeriodEnd,
  });

  await NotificationService.notifyMembershipUpgraded(userId, plan.name);

  // Apply plan credits
  await applyPlanCredits(userId, plan.id, 'yookassa' as any, object.id);

  const amount = object.amount.value;
  const currency = object.amount.currency || 'RUB';
  const userSub = await storage.getUserSubscription(userId);

  try {
    const newTransaction = await storage.createPaymentTransaction({
      userId,
      type: 'subscription',
      gateway: 'yookassa',
      gatewayTransactionId: object.id,
      gatewaySubscriptionId: object.id,
      amount,
      currency: currency.toUpperCase(),
      planId,
      subscriptionId: userSub?.id,
      description: `${plan.displayName} Subscription`,
      billingPeriod,
      status: 'completed',
      completedAt: new Date(),
    });

    await (PaymentAuditService as any).logSubscriptionCreated(
      'yookassa',
      userId,
      newTransaction.id,
      userSub?.id || 'new_sub',
      { planName: plan.name, amount: parseFloat(amount) }
    );

    try {
      await generateInvoiceForTransaction(newTransaction.id);
      await (emailService as any).sendPaymentReceipt(newTransaction.id);
    } catch (emailError: any) {
      console.error(`❌ [YooKassa] Failed to send subscription confirmation email:`, emailError);
    }

    // Sync with other membership services if needed
    await syncUserWithSubscription(userId);

    return {
      success: true,
      action: 'subscription_processed',
      userId,
      transactionId: newTransaction.id,
    };
  } catch (error: any) {
    if (error.message?.includes('unique') || error.message?.includes('duplicate')) {
      return { success: true, action: 'subscription_already_processed', userId };
    }
    throw error;
  }
}
