import { boot } from "https://v2-17-1--edge.netlify.com/bootstrap/index-combined.ts";

const functions = {}; const metadata = { functions: {} };


      try {
        const { default: func } = await import("file:///Users/brandonlucasgreen/Development/unstream/netlify/edge-functions/og-metadata.ts");

        if (typeof func === "function") {
          functions["og-metadata"] = func;
          metadata.functions["og-metadata"] = {"url":"file:///Users/brandonlucasgreen/Development/unstream/netlify/edge-functions/og-metadata.ts"}
        } else {
          console.log("⬥ Failed to load Edge Function og-metadata. The file does not seem to have a function as the default export.");
        }
      } catch (error) {
        console.log("⬥ Failed to run Edge Function og-metadata:");
        console.error(error);
      }
      

boot(() => Promise.resolve(functions));