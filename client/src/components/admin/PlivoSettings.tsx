import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Phone, Key, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PlivoCredentialsSection } from "./plivo/PlivoCredentialsSection";
import { PhonePricingSection } from "./plivo/PhonePricingSection";
import { PhoneNumbersSection } from "./plivo/PhoneNumbersSection";

export default function PlivoSettings() {
  const [activeTab, setActiveTab] = useState("credentials");
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Phone className="h-5 w-5" />
          {t("adminDashboard.plivoSettings.title")}
        </CardTitle>
        <CardDescription>
          {t("adminDashboard.plivoSettings.description")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="credentials" data-testid="tab-plivo-credentials">
              <Key className="h-4 w-4 mr-2" />
              {t("adminDashboard.plivoSettings.tabs.credentials")}
            </TabsTrigger>
            <TabsTrigger value="pricing" data-testid="tab-phone-pricing">
              <Globe className="h-4 w-4 mr-2" />
              {t("adminDashboard.plivoSettings.tabs.pricing")}
            </TabsTrigger>
            <TabsTrigger value="phone-numbers" data-testid="tab-plivo-phone-numbers">
              <Phone className="h-4 w-4 mr-2" />
              {t("adminDashboard.plivoSettings.tabs.phoneNumbers")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="credentials" className="mt-6">
            <PlivoCredentialsSection />
          </TabsContent>

          <TabsContent value="pricing" className="mt-6">
            <PhonePricingSection />
          </TabsContent>

          <TabsContent value="phone-numbers" className="mt-6">
            <PhoneNumbersSection />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
