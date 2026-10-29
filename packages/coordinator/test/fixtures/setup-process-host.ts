import { SetupProcessRunner } from "../../src/setup/process.js";

// A disposable test host: the program's detached Windows helper still inherits Arke's
// private non-breakaway kernel job. No graceful shutdown hooks run in the parent test.
const runner = new SetupProcessRunner();
const helper = "setInterval(()=>{},1000)";
const program = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:'ignore',detached:process.platform==='win32'});child.once('spawn',()=>{process.stdout.write('owned '+process.pid+' '+child.pid+'\\n');setInterval(()=>{},1000)})`;
await runner.run(process.execPath, ["-e", program], new AbortController().signal, text => process.stdout.write(text));
