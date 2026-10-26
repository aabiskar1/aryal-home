import {runAssessmentCli} from './cli/assess-home.js';

const result = await runAssessmentCli(process.argv.slice(2));
console.log(result.output);
process.exitCode = result.exitCode;
