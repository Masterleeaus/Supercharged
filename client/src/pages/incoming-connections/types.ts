import type { UseMutationResult } from "@tanstack/react-query";

export type IncomingConnection = {
  id: string;
  agentId: string;
  phoneNumberId: string;
  createdAt: string;
  agent: {
    id: string;
    name: string;
    elevenLabsVoiceId: string | null;
    language: string | null;
    telephonyProvider?: string | null;
  };
  phoneNumber: {
    id: string;
    phoneNumber: string;
    friendlyName: string | null;
  };
};

export type Agent = {
  id: string;
  name: string;
  type: 'incoming' | 'flow';
  telephonyProvider?: string | null;
};

export type PhoneNumber = {
  id: string;
  phoneNumber: string;
  friendlyName: string | null;
  isConflicted?: boolean;
  conflictReason?: string | null;
  conflictCampaignName?: string | null;
  conflictCampaignStatus?: string | null;
};

export type Stats = {
  totalConnections: number;
  availableNumbers: number;
  totalAgents: number;
};

export type IncomingConnectionsResponse = {
  connections: IncomingConnection[];
  availablePhoneNumbers: PhoneNumber[];
  incomingAgents: Agent[];
  stats: Stats;
};

// Plivo types
export type PlivoAgent = {
  id: string;
  name: string;
  type: string;
  telephonyProvider: string;
};

export type PlivoConnection = {
  phoneNumberId: string;
  phoneNumber: string;
  friendlyName: string | null;
  country: string;
  agent: PlivoAgent | null;
};

export type PlivoAvailableNumber = {
  id: string;
  phoneNumber: string;
  friendlyName: string | null;
  country: string;
  region: string | null;
  isConflicted: boolean;
  conflictReason: string | null;
};

export type PlivoIncomingConnectionsResponse = {
  connections: PlivoConnection[];
  availablePhoneNumbers: PlivoAvailableNumber[];
  availableAgents: PlivoAgent[];
  stats: Stats;
};

// Twilio + OpenAI types
export type TwilioOpenaiAgent = {
  id: string;
  name: string;
  type: string;
  telephonyProvider: string;
  openaiVoice?: string;
};

export type TwilioOpenaiConnection = {
  id: string;
  agentId: string;
  phoneNumberId: string;
  createdAt: string;
  agent: TwilioOpenaiAgent | null;
  phoneNumber: {
    id: string;
    phoneNumber: string;
    friendlyName: string | null;
    country: string | null;
    status: string;
  } | null;
};

export type TwilioOpenaiAvailableNumber = {
  id: string;
  phoneNumber: string;
  friendlyName: string | null;
  country: string | null;
  isConflicted: boolean;
  conflictReason: string | null;
};

export type TwilioOpenaiIncomingConnectionsResponse = {
  connections: TwilioOpenaiConnection[];
  availablePhoneNumbers: TwilioOpenaiAvailableNumber[];
  availableAgents: TwilioOpenaiAgent[];
  stats: Stats;
};

export type EngineTab = 'twilio-elevenlabs' | 'plivo-openai' | 'twilio-openai' | 'custom-voice';

export type VoiceEngineSettings = {
  plivo_openai_engine_enabled: boolean;
  twilio_openai_engine_enabled: boolean;
};

// Subset of a react-query mutation result that the dialogs need.
export type ConnectionMutation<TVars> = Pick<UseMutationResult<unknown, Error, TVars>, "isPending" | "mutate">;
