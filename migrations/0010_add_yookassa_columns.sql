-- Safe incremental migration to add YooKassa columns to plans, credit_packages and user_subscriptions tables
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "yookassa_monthly_price" decimal(10, 2);
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "yookassa_yearly_price" decimal(10, 2);
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "yookassa_monthly_plan_id" text;
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "yookassa_yearly_plan_id" text;

ALTER TABLE "credit_packages" ADD COLUMN IF NOT EXISTS "yookassa_price" decimal(10, 2);

ALTER TABLE "user_subscriptions" ADD COLUMN IF NOT EXISTS "yookassa_subscription_id" text;

-- Add unique constraint safely if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_subscriptions_yookassa_subscription_id_unique'
    ) THEN
        ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_yookassa_subscription_id_unique" UNIQUE ("yookassa_subscription_id");
    END IF;
END
$$;
