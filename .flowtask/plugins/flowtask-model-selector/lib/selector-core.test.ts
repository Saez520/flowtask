import { test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  CLEAR_SENTINEL,
  buildAgentOptions,
  buildAgentSections,
  buildModelOptions,
  buildModelSections,
  buildVariantOptions,
  readAgentModel,
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

test("buildAgentOptions: includes an explicit variant", () => {
  const result = buildAgentOptions({
    agent: { build: { model: "anthropic/claude-opus", variant: "high" } },
  });
  expect(result[0].description).toBe("anthropic/claude-opus (high)");
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

test("buildVariantOptions: resolves variants and preserves order", () => {
  const providers = [
    {
      id: "anthropic",
      models: {
        opus: {
          variants: {
            low: { reasoningEffort: "low" },
            high: { reasoningEffort: "high", textVerbosity: "detailed" },
          },
        },
      },
    },
  ];
  expect(buildVariantOptions("anthropic/opus", providers)).toEqual([
    { title: "low", value: "low", description: "reasoningEffort: low" },
    {
      title: "high",
      value: "high",
      description: "reasoningEffort: high, textVerbosity: detailed",
    },
  ]);
});

test("buildVariantOptions: returns no options for missing or unsupported variants", () => {
  const providers = [
    { id: "anthropic", models: { opus: {}, plain: { variants: [] } } },
  ];
  expect(buildVariantOptions("anthropic/missing", providers)).toEqual([]);
  expect(buildVariantOptions("anthropic/opus", providers)).toEqual([]);
  expect(buildVariantOptions("anthropic/plain", providers)).toEqual([]);
  expect(buildVariantOptions("anthropic/opus/high", providers)).toEqual([]);
});

test("readAgentModel: reads explicit model and optional variant only", () => {
  const config = { agent: { build: { model: "anthropic/opus", variant: "high" } } };
  expect(readAgentModel(config, "build")).toEqual({ model: "anthropic/opus", variant: "high" });
  expect(readAgentModel({ agent: { build: { model: "anthropic/opus" } } }, "build")).toEqual({
    model: "anthropic/opus",
  });
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
      "flowtask-planner": { model: "anthropic/claude-opus", variant: "high", other: "value" },
    },
  };
  const result = removeAgentModel(config, "flowtask-planner");
  expect(result.agent["flowtask-planner"].model).toBeUndefined();
  expect(result.agent["flowtask-planner"].variant).toBeUndefined();
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

test("buildAgentModelPatch: includes variant only when provided", () => {
  expect(buildAgentModelPatch("build", "anthropic/opus", "high")).toEqual({
    agent: { build: { model: "anthropic/opus", variant: "high" } },
  });
  expect(buildAgentModelPatch("build", "anthropic/opus")).toEqual({
    agent: { build: { model: "anthropic/opus" } },
  });
});

// --- buildAgentSections tests ---

test("buildAgentSections: All is first and contains all agents", () => {
  const config = { agent: { "flowtask-a": {}, "flowtask-b": {}, "other": {} } };
  const sections = buildAgentSections(config);
  expect(sections[0].id).toBe("all");
  expect(sections[0].label).toBe("All");
  expect(sections[0].items.length).toBe(3);
});

test("buildAgentSections: family with >= 2 agents creates section with original-case label", () => {
  const config = { agent: { "Flowtask-Runner": {}, "flowtask-planner": {} } };
  const sections = buildAgentSections(config);
  expect(sections.length).toBe(2);
  expect(sections[1].id).toBe("family:Flowtask");
  expect(sections[1].label).toBe("Flowtask");
  expect(sections[1].kind).toBe("family");
  expect(sections[1].items.length).toBe(2);
});

test("buildAgentSections: family is case-insensitive", () => {
  const config = { agent: { "flowtask-alpha": {}, "Flowtask-beta": {}, "FLOWTASK-gamma": {} } };
  const sections = buildAgentSections(config);
  // All three belong to the same family (case-insensitive) → 1 family section
  const familySections = sections.filter((s) => s.kind === "family");
  expect(familySections.length).toBe(1);
  expect(familySections[0].items.length).toBe(3);
});

test("buildAgentSections: agent without dash stays only in All", () => {
  const config = { agent: { lone: {}, "flowtask-a": {}, "flowtask-b": {} } };
  const sections = buildAgentSections(config);
  const familySections = sections.filter((s) => s.kind === "family");
  expect(familySections.length).toBe(1);
  expect(familySections[0].items.length).toBe(2);
  // "lone" is only in All
  const loneInAll = sections[0].items.find((i) => i.value === "lone");
  expect(loneInAll).toBeDefined();
});

test("buildAgentSections: family with exactly 1 agent does not create section", () => {
  const config = { agent: { "flowtask-a": {}, "other-x": {} } };
  const sections = buildAgentSections(config);
  // Both families have only 1 member → no family sections
  expect(sections.length).toBe(1);
  expect(sections[0].id).toBe("all");
});

test("buildAgentSections: empty config → only All with empty items", () => {
  const sections = buildAgentSections({});
  expect(sections.length).toBe(1);
  expect(sections[0].id).toBe("all");
  expect(sections[0].items).toEqual([]);
});

test("buildAgentSections: family sections sorted alphabetically", () => {
  const config = { agent: { "zebra-a": {}, "zebra-b": {}, "alpha-a": {}, "alpha-b": {} } };
  const sections = buildAgentSections(config);
  expect(sections.length).toBe(3);
  expect(sections[1].label).toBe("alpha");
  expect(sections[2].label).toBe("zebra");
});

// --- buildModelSections tests ---

test("buildModelSections: All includes CLEAR_SENTINEL, provider sections do not", () => {
  const providers = [
    { id: "anthropic", name: "Anthropic", models: { opus: {} } },
    { id: "openai", name: "OpenAI", models: { gpt4: {} } },
  ];
  const sections = buildModelSections(providers);
  expect(sections[0].id).toBe("all");
  expect(sections[0].items[0].value).toBe(CLEAR_SENTINEL);

  const anthropicSection = sections.find((s) => s.id === "provider:anthropic");
  expect(anthropicSection).toBeDefined();
  expect(anthropicSection!.items.every((i) => i.value !== CLEAR_SENTINEL)).toBe(true);
});

test("buildModelSections: providers sorted alphabetically", () => {
  const providers = [
    { id: "openai", name: "OpenAI", models: { gpt4: {} } },
    { id: "anthropic", name: "Anthropic", models: { opus: {} } },
  ];
  const sections = buildModelSections(providers);
  expect(sections[1].label).toBe("Anthropic");
  expect(sections[2].label).toBe("OpenAI");
});

test("buildModelSections: empty providers → only All with CLEAR_SENTINEL", () => {
  const sections = buildModelSections([]);
  expect(sections.length).toBe(1);
  expect(sections[0].id).toBe("all");
  expect(sections[0].items.length).toBe(1);
  expect(sections[0].items[0].value).toBe(CLEAR_SENTINEL);
});

test("buildModelSections: provider without models does not create section", () => {
  const providers = [
    { id: "anthropic", name: "Anthropic", models: { opus: {} } },
    { id: "empty", name: "Empty", models: {} },
  ];
  const sections = buildModelSections(providers);
  expect(sections.length).toBe(2); // All + anthropic
  expect(sections.find((s) => s.id === "provider:empty")).toBeUndefined();
});
