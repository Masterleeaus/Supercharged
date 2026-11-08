/*
 * Compatibility shim for optional AgentLabs WhatsApp conversation plugin.
 */

class WhatsAppConversationService {
  async getOrCreateConversation(..._args: any[]): Promise<any> {
    return null;
  }

  async addMessage(..._args: any[]): Promise<any> {
    return null;
  }

  async process(..._args: any[]): Promise<any> {
    return null;
  }

  async sendMessage(..._args: any[]): Promise<any> {
    return {
      success: false,
      reason: "WhatsApp messaging plugin is not installed"
    };
  }
}

export const whatsAppConversationService =
  new WhatsAppConversationService();
