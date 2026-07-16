import { site } from "@/data/site";

export function GET() {
  return new Response(
    `# ${site.name}

${site.description}

## Important links

- [Home](${site.url}/)
- [Sitemap](${new URL("/sitemap.xml", site.url).href})
- [RSS feed](${new URL("/rss.xml", site.url).href})

## Content policy

This site publishes concise Vietnamese articles organized by category. Use the sitemap and RSS feed to discover current articles.
`,
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    }
  );
}
