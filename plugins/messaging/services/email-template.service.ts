/*
 * Compatibility shim for optional AgentLabs messaging plugin.
 * Fails closed when the commercial messaging plugin is absent.
 */

export class EmailTemplateService {
  async render(..._args: any[]): Promise<any> {
    return null;
  }

  async send(..._args: any[]): Promise<any> {
    return null;
  }

  async sendEmailByName(..._args: any[]): Promise<any> {
    return {
      success: false,
      reason: "Messaging email plugin is not installed"
    };
  }
}

export const emailTemplateService = new EmailTemplateService();
