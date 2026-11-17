/**
 * ============================================================
 * © 2025 Titan Zero Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */



import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";


import { Phone, MapPin, Shield } from "lucide-react";







import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";



import { Select } from "@/components/ui/select";


// Default monthly credits - will be overridden by API value
import { PlivoPhoneNumber } from "./types";

export interface PhoneNumberGateDialogsProps {
  plivoReleaseDialogOpen: boolean;
  setPlivoReleaseDialogOpen: (open: boolean) => void;
  plivoNumberToRelease: PlivoPhoneNumber | null;
  handlePlivoRelease: () => void;
  plivoReleaseMutation: { isPending: boolean };
  kycRequiredDialogOpen: boolean;
  setKycRequiredDialogOpen: (open: boolean) => void;
  addressRequiredDialogOpen: boolean;
  setAddressRequiredDialogOpen: (open: boolean) => void;
  addressRequiredCountry: string;
  bundleRequiredDialogOpen: boolean;
  setBundleRequiredDialogOpen: (open: boolean) => void;
  bundleRequiredCountry: string;
  providerSelectDialogOpen: boolean;
  setProviderSelectDialogOpen: (open: boolean) => void;
  handleBuyClick: (provider: "twilio" | "plivo" | "select") => void;
  setBuyDialogOpen: (open: boolean) => void;
  setLocation: (to: string) => void;
  formatPhoneNumber: (phone: string) => string;
  isDemoMode: boolean;
  isKycApproved: boolean;
  plivoEnabled: boolean;
  plivoKycRequired: boolean;
  twilioKycRequired: boolean;
}

export function PhoneNumberGateDialogs(props: PhoneNumberGateDialogsProps) {
  const { t } = useTranslation();
  const { plivoReleaseDialogOpen, setPlivoReleaseDialogOpen, plivoNumberToRelease, handlePlivoRelease, plivoReleaseMutation, kycRequiredDialogOpen, setKycRequiredDialogOpen, addressRequiredDialogOpen, setAddressRequiredDialogOpen, addressRequiredCountry, bundleRequiredDialogOpen, setBundleRequiredDialogOpen, bundleRequiredCountry, providerSelectDialogOpen, setProviderSelectDialogOpen, handleBuyClick, setBuyDialogOpen, setLocation, formatPhoneNumber, isDemoMode, isKycApproved, plivoEnabled, plivoKycRequired, twilioKycRequired } = props;
  return (
    <>
      {/* Plivo Release Dialog */}
      <AlertDialog open={plivoReleaseDialogOpen} onOpenChange={setPlivoReleaseDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Release Plivo Number</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to release {plivoNumberToRelease ? formatPhoneNumber(plivoNumberToRelease.phoneNumber) : ''}? 
              This action cannot be undone and the number will be returned to Plivo's pool.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={plivoReleaseMutation.isPending}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handlePlivoRelease}
              disabled={plivoReleaseMutation.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {plivoReleaseMutation.isPending ? "Releasing..." : "Release Number"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* KYC Required Dialog */}
      <Dialog open={kycRequiredDialogOpen} onOpenChange={setKycRequiredDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-amber-500" />
              KYC Verification Required
            </DialogTitle>
            <DialogDescription>
              To purchase phone numbers, you need to complete KYC verification first.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
              <div className="space-y-3">
                <p className="text-sm">
                  KYC verification is a one-time process. Once approved, you can purchase phone numbers from any provider.
                </p>
                <div className="text-sm">
                  <p className="font-medium mb-2">Required documents:</p>
                  <ul className="list-disc list-inside text-muted-foreground space-y-1">
                    <li>Photo ID</li>
                    <li>Company Registration Certificate</li>
                    <li>GST Certificate</li>
                    <li>Authorization Letter</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setKycRequiredDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => {
              setKycRequiredDialogOpen(false);
              setLocation('/app/settings?tab=kyc');
            }}>
              <Shield className="h-4 w-4 mr-2" />
              Complete KYC Verification
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Address Required Dialog */}
      <Dialog open={addressRequiredDialogOpen} onOpenChange={setAddressRequiredDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5 text-amber-500" />
              Address Verification Required
            </DialogTitle>
            <DialogDescription>
              To purchase phone numbers in {addressRequiredCountry}, you need to add and verify an address first.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
              <div className="space-y-3">
                <p className="text-sm">
                  {addressRequiredCountry} requires address verification for phone number purchases. This is a regulatory requirement.
                </p>
                <div className="text-sm">
                  <p className="font-medium mb-2">What you need to do:</p>
                  <ul className="list-disc list-inside text-muted-foreground space-y-1">
                    <li>Go to Settings → Addresses</li>
                    <li>Add your address for {addressRequiredCountry}</li>
                    <li>Wait for Twilio to verify your address</li>
                    <li>Return here to purchase your phone number</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAddressRequiredDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => {
              setAddressRequiredDialogOpen(false);
              setBuyDialogOpen(false);
              setLocation('/app/settings?tab=addresses');
            }} data-testid="button-go-to-addresses">
              <MapPin className="h-4 w-4 mr-2" />
              Add Address
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Regulatory Bundle Required Dialog */}
      <Dialog open={bundleRequiredDialogOpen} onOpenChange={setBundleRequiredDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-amber-500" />
              Regulatory Compliance Required
            </DialogTitle>
            <DialogDescription>
              Phone numbers in {bundleRequiredCountry} require regulatory compliance approval before purchase.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
              <div className="space-y-3">
                <p className="text-sm">
                  {bundleRequiredCountry} requires identity verification documents to be submitted and approved before phone numbers can be purchased. This is a regulatory requirement.
                </p>
                <p className="text-sm">
                  Please contact your administrator to set up the required regulatory compliance for {bundleRequiredCountry}. The approval process typically takes 1-3 business days.
                </p>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setBundleRequiredDialogOpen(false)} data-testid="button-bundle-close">
              {t('common.close')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Provider Selection Dialog */}
      <Dialog open={providerSelectDialogOpen} onOpenChange={setProviderSelectDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Choose Telephony Provider</DialogTitle>
            <DialogDescription>
              Select which provider you'd like to purchase a phone number from.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 py-4">
            <div 
              className="border rounded-lg p-4 cursor-pointer hover-elevate transition-all"
              onClick={() => {
                setProviderSelectDialogOpen(false);
                handleBuyClick('twilio');
              }}
              data-testid="provider-option-twilio"
            >
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-lg bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                  <Phone className="h-6 w-6 text-red-600 dark:text-red-400" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold">Twilio + ElevenLabs</h3>
                  <p className="text-sm text-muted-foreground">Premium voice quality with ElevenLabs AI</p>
                  {twilioKycRequired && !isKycApproved && (
                    <p className="text-xs text-amber-600 mt-1">KYC verification required</p>
                  )}
                </div>
              </div>
            </div>
            {plivoEnabled ? (
              <div 
                className="border rounded-lg p-4 cursor-pointer hover-elevate transition-all"
                onClick={() => {
                  setProviderSelectDialogOpen(false);
                  handleBuyClick('plivo');
                }}
                data-testid="provider-option-plivo"
              >
                <div className="flex items-center gap-4">
                  <div className="h-12 w-12 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                    <Phone className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold">Plivo + OpenAI</h3>
                    <p className="text-sm text-muted-foreground">OpenAI Realtime voices with Plivo telephony</p>
                    {plivoKycRequired && !isKycApproved && (
                      <p className="text-xs text-amber-600 mt-1">KYC verification required</p>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div 
                className="border rounded-lg p-4 opacity-50 cursor-not-allowed"
                data-testid="provider-option-plivo-disabled"
              >
                <div className="flex items-center gap-4">
                  <div className="h-12 w-12 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                    <Phone className="h-6 w-6 text-gray-400" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-muted-foreground">Plivo + OpenAI</h3>
                    <p className="text-sm text-muted-foreground">Not available - Plivo integration is not enabled</p>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setProviderSelectDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

    </>
  );
}
