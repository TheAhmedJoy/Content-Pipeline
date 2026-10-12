import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

// HTTP Basic Auth in front of the whole app, so nobody can spend API credits or Gemini
// tokens through the deployed routes. Set APP_USERNAME and APP_PASSWORD to enable it.
// Unset locally means no auth; unset on Vercel means every request is refused.

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function proxy(request: NextRequest) {
  const username = process.env.APP_USERNAME;
  const password = process.env.APP_PASSWORD;

  if (!username || !password) {
    if (!process.env.VERCEL) return NextResponse.next();
    return new NextResponse("APP_USERNAME and APP_PASSWORD must be set", { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep !== -1 && safeEqual(decoded.slice(0, sep), username) && safeEqual(decoded.slice(sep + 1), password)) {
      return NextResponse.next();
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Weekly Trend Report", charset="UTF-8"' },
  });
}

export const config = {
  // Everything except Next's static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
