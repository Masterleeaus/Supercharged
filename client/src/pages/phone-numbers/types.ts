export const DEFAULT_MONTHLY_CREDITS = 50;

export interface PublicSettings {
  phone_number_monthly_credits: number;
  low_credits_threshold: number;
  credits_per_minute: number;
}

export interface PhoneNumber {
  id: string;
  phoneNumber: string;
  twilioSid: string;
  friendlyName?: string;
  country: string;
  capabilities?: any;
  status: string;
  purchasedAt: string;
  isSystemPool?: boolean;
}

export interface AvailableNumber {
  phoneNumber: string;
  friendlyName: string;
  locality?: string;
  region?: string;
  addressRequirements?: string;
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
  type?: string;
}

export interface IncomingConnection {
  id: string;
  phoneNumberId: string;
  agentId: string;
  agent: {
    name: string;
  };
}

export interface TwilioCountry {
  id: string;
  code: string;
  name: string;
  dialCode: string;
  isActive: boolean;
  sortOrder: number;
}

export interface VoiceEngineSettings {
  plivo_openai_engine_enabled: boolean;
  twilio_kyc_required: boolean;
  plivo_kyc_required: boolean;
}

export interface UserWithKyc {
  id: string;
  kycStatus?: 'pending' | 'submitted' | 'approved' | 'rejected' | null;
}

export interface PlivoPhoneNumber {
  id: string;
  phoneNumber: string;
  country: string;
  region?: string;
  status: 'pending' | 'active' | 'suspended' | 'released';
  kycStatus?: 'pending' | 'submitted' | 'approved' | 'rejected' | 'requires_resubmission';
  kycRejectionReason?: string;
  purchaseCredits: number;
  monthlyCredits: number;
  purchasedAt: string;
}

export interface PlivoPricing {
  id: string;
  countryCode: string;
  countryName: string;
  purchaseCredits: number;
  monthlyCredits: number;
  kycRequired: boolean;
  isActive: boolean;
}

export interface PlivoAvailableNumber {
  phoneNumber: string;
  country: string;
  region?: string;
  type: string;
  monthlyRentalRate: string;
}

export interface PlivoIncomingConnection {
  phoneNumberId: string;
  phoneNumber: string;
  friendlyName?: string;
  country: string;
  agent?: { id: string; name: string; type?: string; telephonyProvider?: string; } | null;
}

