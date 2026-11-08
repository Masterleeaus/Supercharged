/*
 * Compatibility shim for optional AgentLabs Meta WhatsApp plugin.
 */

export class MetaWhatsAppService {
  async getSettings(..._args: any[]): Promise<any> {
    return null;
  }

  async getTemplateByName(..._args: any[]): Promise<any> {
    return null;
  }

  static buildButtonComponents(..._args: any[]): any[] {
    return [];
  }

  async sendTemplate(..._args: any[]): Promise<any> {
    return {
      success: false,
      reason: "Meta WhatsApp plugin is not installed"
    };
  }

  async sendMessage(..._args: any[]): Promise<any> {
    return {
      success: false,
      reason: "Meta WhatsApp plugin is not installed"
    };
  }
}

export const metaWhatsAppService = new MetaWhatsAppService();
