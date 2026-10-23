import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(
  new URL("../apps/worker/src/isolation.ts", import.meta.url),
);
const script = `
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {prepareIdentity} from '/isolation.ts';
process.env.HARNESS_ISOLATE_AGENTS='1';
await mkdir('/run/harness',{recursive:true,mode:0o700});
await writeFile('/run/harness/worker.json','daemon-secret',{mode:0o600});
await mkdir('/work/sessions/alpha',{recursive:true,mode:0o700});
const identity=await prepareIdentity('/work/sessions/alpha','alpha');
assert.ok(identity);
const child=spawnSync(process.execPath,['--input-type=module','-e',\`
 import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';
 assert.throws(()=>readFileSync('/run/harness/worker.json'),{code:'EACCES'});
 writeFileSync('output.txt','isolated output');console.log('unprivileged agent cannot read its supervisor credential');
\`],{cwd:'/work/sessions/alpha',uid:identity.uid,gid:identity.gid,env:{PATH:process.env.PATH,HOME:identity.home},encoding:'utf8'});
process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0);
assert.equal(await readFile('/work/sessions/alpha/output.txt','utf8'),'isolated output');
await prepareIdentity('/work/sessions/alpha','alpha');
await mkdir('/work/sessions/beta',{recursive:true,mode:0o700});
const second=await prepareIdentity('/work/sessions/beta','beta');assert.ok(second);assert.notEqual(identity.uid,second.uid);
const other=spawnSync(process.execPath,['-e',\`require('node:assert/strict').throws(()=>require('node:fs').readFileSync('/work/sessions/alpha/output.txt'),{code:'EACCES'})\`],{cwd:'/work/sessions/beta',uid:second.uid,gid:second.gid});assert.equal(other.status,0);
console.log('Independent session UID and directory isolation passed.');
`;
const child = spawn(
  "docker",
  [
    "run",
    "--rm",
    "-i",
    "--network=none",
    "--security-opt=no-new-privileges",
    "--cap-drop=ALL",
    "--cap-add=CHOWN",
    "--cap-add=SETUID",
    "--cap-add=SETGID",
    "--cap-add=DAC_OVERRIDE",
    "--cap-add=FOWNER",
    "--memory=256m",
    "--cpus=1",
    "--mount",
    `type=bind,source=${modulePath},target=/isolation.ts,readonly`,
    process.env.HARNESS_NODE_TEST_IMAGE ?? "node:24-alpine",
    "node",
    "--input-type=module",
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
child.stdin.end(script);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
