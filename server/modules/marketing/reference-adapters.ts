/**
 * Reuse the canonical chatbot storage instead of duplicating chatbot tables.
 * The campaigns draft conflicts with an existing legacy voice campaigns table;
 * campaign references therefore fail closed until the new module is deployed.
 */
import type { ChatbotRefs, CampaignRefs } from './ports.ts';
import type { ChatbotStorage } from '../chatbot/chatbot-storage.ts';
import { assertCompanyId } from '../../infrastructure/database/tenant-context.ts';
export function chatbotReferences(storage: Pick<ChatbotStorage,'findChatbot'>): ChatbotRefs {
 if (!storage || typeof storage.findChatbot !== 'function') throw new Error('marketing: canonical chatbot storage required');
 return {
  async chatbotExists(companyId:string,id:string) {
   assertCompanyId(companyId);
   if(typeof id!=='string'||!id.trim())return false;
   return (await storage.findChatbot(companyId,id))!==null;
  }
 };
}
export function unavailableCampaignReferences(): CampaignRefs {
 return {
  async campaignExists(companyId:string,_id:string) {
   assertCompanyId(companyId);
   return false;
  }
 };
}
