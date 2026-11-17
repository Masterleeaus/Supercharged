export interface PlivoCredential {
  id: string;
  name: string;
  authId: string;
  isPrimary: boolean;
  isActive: boolean;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PhonePricing {
  id: string;
  countryCode: string;
  countryName: string;
  purchaseCredits: number;
  monthlyCredits: number;
  kycRequired: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlivoPhoneNumber {
  id: string;
  phoneNumber: string;
  country: string;
  region: string | null;
  numberType: string;
  status: string;
  userId: string | null;
  userEmail?: string;
  userName?: string;
  isSystemPool: boolean;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  name?: string | null;
}

export interface UserSearchResponse {
  users: User[];
  total: number;
  hasMore: boolean;
}
