// Which browser origins are ours, and where checkout sends the browser back.
// createOrigins(appOrigins) returns allowedOrigin (CORS and return URLs),
// appOrigin and checkoutReturnUrls. Dev servers match DEV_ORIGIN on any
// port, because `ng serve` picks whatever port is free.

const DEV_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/;

export type ReturnUrls = { success: string; cancel: string };

export function createOrigins(APP_ORIGINS: string[]) {
  /** The single source of truth for "is this origin ours?" — used for both CORS
   * and the Stripe return URL. Only ever returns an origin we recognise. */
  function allowedOrigin(origin: string | undefined): string | null {
    if (!origin) return null;
    if (DEV_ORIGIN.test(origin)) return origin;
    return APP_ORIGINS.includes(origin) ? origin : null;
  }

  /** Where Stripe sends the browser back. Prefer the caller's origin when we trust
   * it, so any `ng serve` port works; fall back to the configured deployment. */
  function appOrigin(
    c: { req: { header: (k: string) => string | undefined } },
  ): string {
    return allowedOrigin(c.req.header("origin")) ?? APP_ORIGINS[0] ??
      "http://localhost:4200";
  }

  /** Mobile checkouts bounce back into the app via its deep link; web callers
   * keep the site URLs (param absent → unchanged behaviour). */
  function checkoutReturnUrls(
    c: { req: { header: (k: string) => string | undefined } },
    body: Record<string, unknown>,
  ): ReturnUrls {
    if (body.platform === "mobile") {
      return {
        success: "vansen://billing-return?status=success",
        cancel: "vansen://billing-return?status=cancel",
      };
    }
    return {
      success: `${appOrigin(c)}/app?checkout=success`,
      cancel: `${appOrigin(c)}/app?checkout=canceled`,
    };
  }

  return { allowedOrigin, appOrigin, checkoutReturnUrls };
}
