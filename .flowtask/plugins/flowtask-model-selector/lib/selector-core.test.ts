import { test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  CLEAR_SENTINEL,
  buildAgentOptions,
  buildModelOptions,
  resolveGlobalConfigFile,
  stripJsonBom,
  removeAgentModel,
  atomicWriteFile,
  buildAgentModelPatch,
} from "./selector-core";

test("buildAgentOptions: empty config", () => {
  const result = buildAgentOptions({});
  expect(result).toEqual([]);
});

test("buildAgentOptions: alphabetical order", () => {
  const config = {
    agent: {
      zebra: {},
      apple: {},
      monkey: {},
    },
  };
  const result = buildAgentOptions(config);
  expect(result.map((o) => o.value)).toEqual(["apple", "monkey", "zebra"]);
});

test("buildAgentOptions: description with agent model override", () => {
  const config = {
    agent: {
      "flowtask-planner": { model: "anthropic/claude-opus" },
    },
    model: "openai/gpt-4",
  };
  const result = buildAgentOptions(config);
  expect(result).toEqual([
    {
      title: "flowtask-planner",
      value: "flowtask-planner",
      description: "anthropic/claude-opus",
    },
  ]);
});

test("buildAgentOptions: description with base model (no agent override)", () => {
  const config = {
    agent: {
      "flowtask-planner": {},
    },
    model: "openai/gpt-4",
  };
  const result = buildAgentOptions(config);
  expect(result).toEqual([
    {
      title: "flowtask-planner",
      value: "flowtask-planner",
      description: "openai/gpt-4",
    },
  ]);
});

test("buildAgentOptions: description with inheritance (no model anywhere)", () => {
  const config = {
    agent: {
      "flowtask-planner": {},
    },
  };
  const result = buildAgentOptions(config);
  expect(result).toEqual([
    {
      title: "flowtask-planner",
      value: "flowtask-planner",
      description: "(hereda)",
    },
  ]);
});

test("buildModelOptions: CLEAR_SENTINEL is first", () => {
  const providers = [
    {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-opus": { id: "claude-opus", name: "Claude Opus" },
      },
    },
  ];
  const result = buildModelOptions(providers);
  expect(result[0].value).toBe(CLEAR_SENTINEL);
  expect(result[0].title).toContain("hereda del runner");
});

test("buildModelOptions: flatten multi-provider", () => {
  const providers = [
    {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-opus": { id: "claude-opus", name: "Claude Opus" },
        "claude-sonnet": { id: "claude-sonnet", name: "Claude Sonnet" },
      },
    },
    {
      id: "openai",
      name: "OpenAI",
      models: {
        "gpt-4": { id: "gpt-4", name: "GPT-4" },
      },
    },
  ];
  const result = buildModelOptions(providers);
  // 1 CLEAR_SENTINEL + 2 anthropic + 1 openai = 4 total
  expect(result.length).toBe(4);
  expect(result[1]).toEqual({
    title: "Claude Opus",
    value: "anthropic/claude-opus",
    description: "Anthropic",
  });
  expect(result[3]).toEqual({
    title: "GPT-4",
    value: "openai/gpt-4",
    description: "OpenAI",
  });
});

test("buildModelOptions: fallback to model id if name is missing", () => {
  const providers = [
    {
      id: "custom",
      name: "Custom",
      models: {
        "model-without-name": { id: "model-without-name" },
      },
    },
  ];
  const result = buildModelOptions(providers);
  expect(result[1].title).toBe("model-without-name");
});

test("stripJsonBom: removes UTF-8 BOM", () => {
  const textWithBom = "﻿{\"test\": true}";
  const result = stripJsonBom(textWithBom);
  expect(result).toBe('{"test": true}');
});

test("stripJsonBom: no-op on text without BOM", () => {
  const text = '{"test": true}';
  const result = stripJsonBom(text);
  expect(result).toBe(text);
});

test("removeAgentModel: does not mutate input", () => {
  const original = {
    agent: {
      "flowtask-planner": { model: "anthropic/claude-opus" },
    },
  };
  const cloned = JSON.parse(JSON.stringify(original));
  removeAgentModel(original, "flowtask-planner");
  expect(original).toEqual(cloned);
});

test("removeAgentModel: removes model field", () => {
  const config = {
    agent: {
      "flowtask-planner": { model: "anthropic/claude-opus", other: "value" },
    },
  };
  const result = removeAgentModel(config, "flowtask-planner");
  expect(result.agent["flowtask-planner"].model).toBeUndefined();
  expect(result.agent["flowtask-planner"].other).toBe("value");
});

test("removeAgentModel: preserves empty agent object after deletion", () => {
  const config = {
    agent: {
      "flowtask-planner": { model: "anthropic/claude-opus" },
    },
  };
  const result = removeAgentModel(config, "flowtask-planner");
  expect(result.agent["flowtask-planner"]).toEqual({});
});

test("atomicWriteFile: writes file atomically", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-test-"));
  const filePath = path.join(tmpDir, "test.json");
  const content = '{"test": true}';

  atomicWriteFile(filePath, content);

  const written = fs.readFileSync(filePath, "utf-8");
  expect(written).toBe(content);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});

test("atomicWriteFile: cleans up tmp file on success", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-test-"));
  const filePath = path.join(tmpDir, "test.json");
  const content = '{"test": true}';

  atomicWriteFile(filePath, content);

  // Check no .tmp files remain
  const files = fs.readdirSync(tmpDir);
  const tmpFiles = files.filter((f) => f.includes(".tmp"));
  expect(tmpFiles.length).toBe(0);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});

test("atomicWriteFile: throws on inaccessible directory", () => {
  expect(() => {
    atomicWriteFile("/root/inaccessible/test.json", '{"test": true}');
  }).toThrow();
});

test("resolveGlobalConfigFile: returns a path", () => {
  const result = resolveGlobalConfigFile();
  expect(typeof result).toBe("string");
  expect(result).toContain(".config");
});

test("buildAgentModelPatch: creates correct patch structure", () => {
  const result = buildAgentModelPatch("flowtask-planner", "anthropic/claude-opus");
  expect(result).toEqual({
    agent: {
      "flowtask-planner": {
        model: "anthropic/claude-opus",
      },
    },
  });
});
