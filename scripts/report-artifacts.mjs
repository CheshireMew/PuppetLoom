import { reportManagedArtifacts } from "./lib/managed-run.mjs";

console.log(JSON.stringify(await reportManagedArtifacts(), null, 2));
