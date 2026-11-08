/*
 * Compatibility shim for optional AgentLabs Whatsway plugin.
 */

class WhatswayService {
  async getSettings(..._args: any[]): Promise<any> {
    return null;
  }

  async sendTemplate(..._args: any[]): Promise<any> {
    return {
      success: false,
      reason: "Whatsway plugin is not installed"
    };
  }

  async sendMessage(..._args: any[]): Promise<any> {
    return {
      success: false,
      reason: "Whatsway plugin is not installed"
    };
  }
}

export const whatswayService = new WhatswayService();
