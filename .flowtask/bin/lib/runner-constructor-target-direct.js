/** The executable Runner -> Constructor target-direct boundary. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dispatchTargetDirectDescriptor, rehydrateTargetDirectDescriptor, serializeTargetDirectDescriptor } from "./target-direct-transport.js";

export function dispatchRunnerTargetDirect(descriptor, constructor) {
  return constructor(receiveConstructorTargetDirect(serializeTargetDirectDescriptor(descriptor)));
}

export function receiveConstructorTargetDirect(record) {
  return rehydrateTargetDirectDescriptor(record);
}

/** Real shell call-site: transport a persisted Runner record to the Constructor. */
export function dispatchRunnerRecordToConstructor(file, constructor) {
  const descriptor = receiveConstructorTargetDirect(fs.readFileSync(file));
  return dispatchRunnerTargetDirect(descriptor, constructor);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new TypeError("target_direct_descriptor file required");
  process.stdout.write(dispatchRunnerRecordToConstructor(file, (descriptor) =>
    dispatchTargetDirectDescriptor(descriptor, (rehydrated) =>
      `${Object.entries(rehydrated).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    ),
  ));
}
