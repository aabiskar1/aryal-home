import {runLearnLightingCli} from './cli/learn-lighting.js';

const result = await runLearnLightingCli(process.argv.slice(2));
console.log(result.output);
process.exitCode = result.exitCode;
