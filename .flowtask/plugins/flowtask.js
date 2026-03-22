import { tool } from "@opencode-ai/plugin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

export const FlowTaskPlugin = async ({ client }) => {
  console.log("FlowTask plugin loaded");

  return {
    "server.connected": async () => {
      console.log("FlowTask: Server connected, agents ready");
    },

    "session.created": async ({ session }) => {
      console.log("FlowTask: Session created");
    },

    tool: {
      flowtask_status: tool({
        description: "Show FlowTask and Engram memory statistics",
        args: {},
        async execute(args, context) {
          return "Use the /status command in OpenCode to view FlowTask status.";
        },
      }),
    },
  };
};

export default FlowTaskPlugin;
