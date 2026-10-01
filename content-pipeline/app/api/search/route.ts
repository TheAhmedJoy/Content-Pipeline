import { type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const query = searchParams.get("query");
  const region = searchParams.get("region") ?? "AU";

  if (!query) {
    return Response.json({ error: "Missing query parameter" }, { status: 400 });
  }

  const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "SCRAPE_CREATORS_API_KEY not set" }, { status: 500 });
  }

  const url = new URL("https://api.scrapecreators.com/v1/tiktok/search/top");
  url.searchParams.set("query", query);
  url.searchParams.set("publish_time", "this-week");
  url.searchParams.set("sort_by", "most-liked");
  url.searchParams.set("region", region);

  const response = await fetch(url.toString(), {
    headers: {
      "x-api-key": apiKey,
    },
  });

  const data = await response.json();

  return Response.json({
    status: response.status,
    query,
    region,
    data,
  });
}
