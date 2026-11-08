function getDomain(fallbackHost) {
  let domain;
  const isProduction = process.env.NODE_ENV === "production";
  if (!isProduction) {
    if (process.env.DEV_DOMAIN) {
      domain = process.env.DEV_DOMAIN;
    }
  }
  if (!domain && process.env.APP_DOMAIN) {
    domain = process.env.APP_DOMAIN;
  }
  if (!domain && process.env.BASE_URL) {
    domain = process.env.BASE_URL;
  }
  if (!domain && process.env.APP_URL) {
    domain = process.env.APP_URL;
  }
  if (!domain && fallbackHost) {
    domain = fallbackHost;
  }
  if (!domain) {
    console.warn("\u26A0\uFE0F  [Domain] No domain configured! Webhook/callback URLs will use http://localhost:5000 which will NOT work in production. Please set APP_DOMAIN in your environment variables (e.g., APP_DOMAIN=app.yourdomain.com).");
    domain = "http://localhost:5000";
  }
  if (!domain.startsWith("http://") && !domain.startsWith("https://")) {
    domain = "https://" + domain;
  }
  return domain;
}
export {
  getDomain
};
