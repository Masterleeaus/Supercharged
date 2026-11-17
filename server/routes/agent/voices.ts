/**
 * ============================================================
 * © 2025 Titan Zero Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 * Copyright (c) Titan Zero.
 * ============================================================
 */

/** Agent routes: voice list, preview and OpenAI voice preview routes. Split from server/routes/agent-routes.ts (issue #17). Paths and handlers are unchanged. */
import { Router, Request, Response } from "express";
import { RouteContext, AuthRequest } from "../common";
import { eq, and, sql } from "drizzle-orm";
import { llmModels, flows, FlowNode, FlowEdge, knowledgeBase } from "@shared/schema";
import { ElevenLabsService, isAgentOnSipPhoneNumber, getSipTrunkOutboundAddress } from "../../services/elevenlabs";
import { sanitizeLlmModel } from "../../utils/llm-sanitize";
import { ElevenLabsPoolService } from "../../services/elevenlabs-pool";
import { OpenAIPoolService } from "../../engines/plivo/services/openai-pool.service";
import { IncomingAgentService } from "../../services/incoming-agent";
import { FlowAgentService } from "../../services/flow-agent";
import { setupRAGToolForAgent, isRAGEnabled } from "../../services/rag-elevenlabs-tool";
import { logger } from "../../utils/logger";

export function registerVoiceRoutes(router: Router, ctx: RouteContext): void {
  const { storage, authenticateHybrid } = ctx;
  // Voices Routes (Agent-related)
  // ========================================

  router.get("/api/voices", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const voices = await storage.getUserVoices(req.userId!);
      res.json(voices);
    } catch (error: any) {
      logger.error("Get voices error:", error);
      res.status(500).json({ error: "Failed to get voices" });
    }
  });

  router.post("/api/voices/preview", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { voiceId, text, voiceSettings, modelId, language } = req.body;

      if (!voiceId) {
        return res.status(400).json({ error: "Voice ID is required" });
      }

      const defaultPreviewTexts: Record<string, string> = {
        en: "Hello! This is a preview of how I'll sound. I can adjust my tone and style based on your preferences.",
        es: "¡Hola! Esta es una vista previa de cómo sonaré. Puedo ajustar mi tono y estilo según tus preferencias.",
        fr: "Bonjour ! Voici un aperçu de ma voix. Je peux ajuster mon ton et mon style selon vos préférences.",
        de: "Hallo! Dies ist eine Vorschau meiner Stimme. Ich kann meinen Ton und Stil an Ihre Wünsche anpassen.",
        it: "Ciao! Questa è un'anteprima di come suonerò. Posso adattare il mio tono e stile in base alle tue preferenze.",
        pt: "Olá! Esta é uma prévia de como vou soar. Posso ajustar meu tom e estilo de acordo com suas preferências.",
        ar: "مرحباً! هذه معاينة لصوتي. يمكنني تعديل نبرتي وأسلوبي حسب تفضيلاتك.",
        hi: "नमस्ते! यह मेरी आवाज़ का पूर्वावलोकन है। मैं आपकी पसंद के अनुसार अपनी आवाज़ और शैली बदल सकता हूँ।",
        ja: "こんにちは！これは私の声のプレビューです。あなたの好みに合わせてトーンやスタイルを調整できます。",
        ko: "안녕하세요! 이것은 제 목소리의 미리보기입니다. 귀하의 선호도에 따라 톤과 스타일을 조정할 수 있습니다.",
        zh: "你好！这是我声音的预览。我可以根据你的喜好调整语调和风格。",
        nl: "Hallo! Dit is een voorbeeld van hoe ik zal klinken. Ik kan mijn toon en stijl aanpassen aan uw voorkeuren.",
        pl: "Cześć! To podgląd mojego głosu. Mogę dostosować ton i styl do Twoich preferencji.",
        ru: "Привет! Это предварительный просмотр моего голоса. Я могу настроить тон и стиль в соответствии с вашими предпочтениями.",
        tr: "Merhaba! Bu sesimin bir ön izlemesidir. Tercihlerinize göre tonumu ve tarzımı ayarlayabilirim.",
        uk: "Привіт! Це попередній перегляд мого голосу. Я можу налаштувати тон і стиль відповідно до ваших уподобань.",
      };
      const langKey = language ? language.substring(0, 2).toLowerCase() : "en";
      const previewText = text || defaultPreviewTexts[langKey] || defaultPreviewTexts["en"];

      if (previewText.length > 500) {
        return res.status(400).json({ error: "Preview text cannot exceed 500 characters" });
      }

      const credential = await ElevenLabsPoolService.getUserCredential(req.userId!);
      if (!credential) {
        return res.status(500).json({ error: "No available ElevenLabs API keys" });
      }

      const previewService = new ElevenLabsService(credential.apiKey);

      const audioBuffer = await previewService.generateVoicePreview({
        voiceId,
        text: previewText,
        voiceSettings,
        modelId,
      });

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', audioBuffer.length);
      res.setHeader('Cache-Control', 'no-cache');

      res.send(audioBuffer);
    } catch (error: any) {
      logger.error("Voice preview error:", error);
      res.status(500).json({ error: "Failed to generate voice preview" });
    }
  });

  // ========================================
  // OpenAI Voice Preview Route
  // ========================================

  router.post("/api/openai/voices/preview", authenticateHybrid, async (req: AuthRequest, res: Response) => {
    try {
      const { voiceId, text, speed } = req.body;

      if (!voiceId) {
        return res.status(400).json({ error: "Voice ID is required" });
      }

      const validVoices = ["alloy", "echo", "shimmer", "ash", "ballad", "coral", "sage", "verse", "cedar", "marin"];
      if (!validVoices.includes(voiceId)) {
        return res.status(400).json({ error: `Invalid voice. Must be one of: ${validVoices.join(", ")}` });
      }

      const previewText = text || "Hello! This is a preview of how I'll sound. I can adjust my tone and style based on your preferences.";

      if (previewText.length > 500) {
        return res.status(400).json({ error: "Preview text cannot exceed 500 characters" });
      }

      const credential = await OpenAIPoolService.getLeastLoadedCredential();
      if (!credential) {
        return res.status(500).json({ error: "No available OpenAI API keys" });
      }

      const realtimeOnlyVoices = ["ballad", "verse", "cedar", "marin"];
      let response;

      if (realtimeOnlyVoices.includes(voiceId)) {
        logger.info(`🎙️ Voice preview: requesting ${voiceId} via Chat Completions audio endpoint`);
        
        const audioModels = [
          "gpt-4o-mini-audio-preview",
          "gpt-4o-audio-preview-2025-06-03",
          "gpt-4o-audio-preview",
        ];

        for (const model of audioModels) {
          response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${credential.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              modalities: ["text", "audio"],
              audio: {
                voice: voiceId,
                format: "wav",
              },
              messages: [
                {
                  role: "user",
                  content: `Please read the following text exactly as written: ${previewText}`
                }
              ]
            }),
          });

          if (response.ok) {
            const data = await response.json();
            const base64Audio = data.choices?.[0]?.message?.audio?.data;
            if (base64Audio) {
              const audioBuffer = Buffer.from(base64Audio, "base64");
              res.setHeader('Content-Type', 'audio/wav');
              res.setHeader('Content-Length', audioBuffer.length);
              res.setHeader('Cache-Control', 'no-cache');
              return res.send(audioBuffer);
            }
          }
          logger.warn(`⚠️ Audio model "${model}" failed (status: ${response.status})`);
        }

        logger.warn(`⚠️ All audio preview models failed — falling back to TTS with "alloy" voice`);
      }

      // Standard path or fallback path (if chat completion call failed for realtime-only voices)
      const finalVoiceId = realtimeOnlyVoices.includes(voiceId) ? "alloy" : voiceId;
      logger.info(`🎙️ Voice preview: requesting ${finalVoiceId} via TTS API`);

      response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${credential.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          input: previewText,
          voice: finalVoiceId,
          response_format: "mp3",
          speed: speed || 1.0,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("OpenAI TTS error:", errorText);
        return res.status(500).json({ error: "Failed to generate voice preview" });
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', audioBuffer.length);
      res.setHeader('Cache-Control', 'no-cache');

      res.send(audioBuffer);
    } catch (error: any) {
      logger.error("OpenAI voice preview error:", error);
      res.status(500).json({ error: "Failed to generate voice preview" });
    }
  });
}
