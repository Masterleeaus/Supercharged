import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { parseServerDeskMode } from "@/lib/desk-product-mode";
import { modeAvailability, type ModeFlags } from "@/lib/mode-capabilities";
import type { ProductMode } from "@/lib/desk-product-mode";

const FLAGS: ModeFlags = {
  // Match deployment flags to the server configuration. Client flags never grant access.
  inbox: import.meta.env.VITE_ENABLE_CHATBOT_INBOX === "true",
  marketing: true,
};
export function useDeskProductMode(selected: ProductMode) {
  const query = useQuery({
    queryKey: ["/api/desk-mode"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/desk-mode");
      if (!response.ok) throw new Error("Mode lookup unavailable");
      return response.json() as Promise<unknown>;
    },
    retry: false,
  });
  const value = query.data;
  const mode = typeof value === "object" && value !== null && "mode" in value
    ? parseServerDeskMode(value.mode)
    : null;
  return {
    loading: query.isPending,
    availability: modeAvailability(selected, query.isError ? null : mode, FLAGS),
  };
}
