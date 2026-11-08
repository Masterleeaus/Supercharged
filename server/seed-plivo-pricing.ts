/**
 * Plivo Phone Pricing Seed Data
 * 
 * This file contains default country pricing for Plivo phone number purchasing.
 * 
 * @copyright Diploy - CodeCanyon/Envato Distribution
 * @license See LICENSE.md for full terms
 */

import { db } from "./db";
import { plivoPhonePricing } from "@shared/schema";
import { eq } from "drizzle-orm";

export const PLIVO_PRICING_SEED_DATA = [
  {
    countryCode: "US",
    countryName: "United States",
    purchaseCredits: 100,
    monthlyCredits: 50,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "GB",
    countryName: "United Kingdom",
    purchaseCredits: 100,
    monthlyCredits: 50,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "CA",
    countryName: "Canada",
    purchaseCredits: 100,
    monthlyCredits: 50,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "AU",
    countryName: "Australia",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "DE",
    countryName: "Germany",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: true,
    isActive: true,
  },
  {
    countryCode: "FR",
    countryName: "France",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: true,
    isActive: true,
  },
  {
    countryCode: "ES",
    countryName: "Spain",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: true,
    isActive: true,
  },
  {
    countryCode: "IT",
    countryName: "Italy",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: true,
    isActive: true,
  },
  {
    countryCode: "NL",
    countryName: "Netherlands",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "BR",
    countryName: "Brazil",
    purchaseCredits: 200,
    monthlyCredits: 100,
    kycRequired: true,
    isActive: true,
  },
  {
    countryCode: "IE",
    countryName: "Ireland",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "NZ",
    countryName: "New Zealand",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "SG",
    countryName: "Singapore",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "HK",
    countryName: "Hong Kong",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "IN",
    countryName: "India",
    purchaseCredits: 200,
    monthlyCredits: 100,
    kycRequired: true,
    isActive: true,
  },
  {
    countryCode: "MX",
    countryName: "Mexico",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "BE",
    countryName: "Belgium",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "CH",
    countryName: "Switzerland",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "DK",
    countryName: "Denmark",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "NO",
    countryName: "Norway",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "SE",
    countryName: "Sweden",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: false,
    isActive: true,
  },
  {
    countryCode: "PL",
    countryName: "Poland",
    purchaseCredits: 150,
    monthlyCredits: 75,
    kycRequired: false,
    isActive: true,
  },
];

export async function seedPlivoPhonePricing() {
  console.log("📞 Seeding Plivo Phone Pricing...");

  try {
    let seededCount = 0;
    for (const record of PLIVO_PRICING_SEED_DATA) {
      // Check if this country code already exists
      const [existing] = await db
        .select()
        .from(plivoPhonePricing)
        .where(eq(plivoPhonePricing.countryCode, record.countryCode))
        .limit(1);

      if (!existing) {
        await db.insert(plivoPhonePricing).values(record);
        seededCount++;
      }
    }

    if (seededCount > 0) {
      console.log(`   ✅ Seeded ${seededCount} new Plivo phone pricing countries`);
    } else {
      console.log("   ℹ️  All Plivo Phone Pricing countries already exist, skipping...");
    }
  } catch (error) {
    console.error("❌ Error seeding Plivo Phone Pricing:", error);
    throw error;
  }
}

// Allow running standalone
const isRunningStandalone = process.argv[1]?.includes('seed-plivo-pricing') &&
  !process.argv[1]?.includes('dist/index.js');

if (isRunningStandalone) {
  seedPlivoPhonePricing()
    .then(() => {
      console.log("✅ Plivo Phone Pricing seeding complete!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Plivo Phone Pricing seeding failed:", error);
      process.exit(1);
    });
}
