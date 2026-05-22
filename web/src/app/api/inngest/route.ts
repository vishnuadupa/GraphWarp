import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { processDocument } from "@/lib/inngest/functions";

// Create an API that serves functions
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    processDocument
  ],
});
