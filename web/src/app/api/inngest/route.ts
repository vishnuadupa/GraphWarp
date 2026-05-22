import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { processDocument } from "@/lib/inngest/functions";

// Force Node.js runtime — Inngest uses Neo4j + fs APIs incompatible with Edge
export const runtime = "nodejs";

// Create an API that serves functions
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    processDocument
  ],
});
