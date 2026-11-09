import type { Express, Response } from "express";
import { storage } from "../../storage";
import { authenticateToken, type AuthRequest } from "../../middleware/auth";
import { elevenLabsService, ElevenLabsService } from "../../services/elevenlabs";
import { ElevenLabsPoolService } from "../../services/elevenlabs-pool";
import { safeErrorMessage } from "../../utils/safe-error";

export function registerElevenLabsVoiceRoutes(app: Express): void {
  // ElevenLabs Voices routes
  // Uses pool credentials (user affinity) to fetch voices, not global env var
  app.get("/api/elevenlabs/voices", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      // Get credential from pool - use user affinity for consistency
      const credential = await ElevenLabsPoolService.getUserCredential(req.userId!);

      if (!credential) {
        // No pool credentials available - return empty array with helpful message
        console.warn("⚠️ [Voices] No ElevenLabs credentials in pool - voices cannot be fetched");
        return res.json([]);
      }

      // Create service instance with pool credential
      const poolService = new ElevenLabsService(credential.apiKey);
      const { voices } = await poolService.listVoices();
      res.json(voices);
    } catch (error: any) {
      console.error("Get ElevenLabs voices error:", error);
      res.status(500).json({ error: safeErrorMessage(error, "Failed to get voices") });
    }
  });

  // ElevenLabs Voice Limit - Returns voice slot usage and limits
  // Uses pool credentials to fetch subscription info
  app.get("/api/elevenlabs/voice-limit", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      // Get credential from pool for this user
      const credential = await ElevenLabsPoolService.getUserCredential(req.userId!);

      if (!credential) {
        // No pool credentials - return defaults
        return res.json({
          used: 0,
          limit: 30,
          atLimit: false,
          canExtend: false,
          tier: 'not_configured',
        });
      }

      const poolService = new ElevenLabsService(credential.apiKey);
      const subscription = await poolService.getSubscription();

      // ElevenLabs API returns voice_slots_used and voice_limit (not voice_count/max_voice_count)
      const used = subscription.voice_slots_used ?? 0;
      const limit = subscription.voice_limit ?? 30;

      const response = {
        used,
        limit,
        atLimit: used >= limit,
        canExtend: subscription.can_extend_voice_limit ?? false,
        tier: subscription.tier ?? 'unknown',
      };
      res.json(response);
    } catch (error: any) {
      console.error("Get voice limit error:", error);
      // Fallback to reasonable defaults if subscription fetch fails
      res.json({
        used: 0,
        limit: 30,
        atLimit: false,
        canExtend: false,
        tier: 'unknown',
      });
    }
  });

  // ElevenLabs Shared Voices (Voice Library) - 5000+ community voices (LEGACY - use /api/voices/search instead)
  app.get("/api/elevenlabs/shared-voices", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      const {
        page,
        pageSize,
        search,
        language,
        gender,
        age,
        accent,
        category,
        useCases
      } = req.query;

      const result = await elevenLabsService.listSharedVoices({
        page: page ? parseInt(page as string) : undefined,
        pageSize: pageSize ? parseInt(pageSize as string) : 100,
        search: search as string | undefined,
        language: language as string | undefined,
        gender: gender as string | undefined,
        age: age as string | undefined,
        accent: accent as string | undefined,
        category: category as string | undefined,
        useCases: useCases ? (useCases as string).split(',') : undefined,
      });

      res.json(result);
    } catch (error: any) {
      console.error("Get ElevenLabs shared voices error:", error);
      res.status(500).json({ error: safeErrorMessage(error, "Failed to get shared voices") });
    }
  });

  // ElevenLabs LLM Pricing route
  app.get("/api/elevenlabs/llm-pricing", authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      // Fetch LLM pricing from ElevenLabs
      const pricing = await elevenLabsService.getLLMPricing();

      // Get admin margin percentage from global settings (default to 0% if not set)
      const marginSetting = await storage.getGlobalSetting('llm_pricing_margin');
      const marginPercentage = marginSetting ? parseFloat(String(marginSetting.value)) : 0;

      // Apply margin to all prices
      const pricingWithMargin = {
        ...pricing,
        llm_prices: pricing.llm_prices.map(llm => ({
          ...llm,
          // Apply margin percentage (e.g., 10% margin = multiply by 1.10)
          cost_per_million_input_tokens: llm.cost_per_million_input_tokens * (1 + marginPercentage / 100),
          cost_per_million_output_tokens: llm.cost_per_million_output_tokens * (1 + marginPercentage / 100),
          cost_per_million_input_cache_read_tokens: llm.cost_per_million_input_cache_read_tokens
            ? llm.cost_per_million_input_cache_read_tokens * (1 + marginPercentage / 100)
            : undefined,
          cost_per_million_input_cache_write_tokens: llm.cost_per_million_input_cache_write_tokens
            ? llm.cost_per_million_input_cache_write_tokens * (1 + marginPercentage / 100)
            : undefined,
          // Add margin info for transparency
          margin_percentage: marginPercentage,
          original_cost_per_million_input_tokens: llm.cost_per_million_input_tokens,
          original_cost_per_million_output_tokens: llm.cost_per_million_output_tokens,
        })),
      };

      res.json(pricingWithMargin);
    } catch (error: any) {
      console.error("Get LLM pricing error:", error);
      res.status(500).json({ error: safeErrorMessage(error, "Failed to get LLM pricing") });
    }
  });
}
