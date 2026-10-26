import {runLightingThresholdCli} from './cli/lighting-threshold.js';

const result = await runLightingThresholdCli(process.argv.slice(2));
console.log(result.output);
process.exitCode = result.exitCode;
